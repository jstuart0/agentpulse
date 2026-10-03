/**
 * SSO user identity: resolving a forwardauth subject to a `users` row.
 *
 * Hides: the SSO username convention ("sso:" + provider + ":" + subject),
 * the password sentinel ("!", never verifiable), create-if-missing, and the
 * unique-violation race retry.
 *
 * One row per (provider, subject) — enforced by idx_users_provider_subject.
 * A disabled row is returned as disabled and never recreated. subject_source
 * is written at creation and filled once from null by a later call with a
 * non-null source; a non-null value is never changed.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { config } from "../config.js";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { users } from "../db/schema/index.js";

/** Where the subject came from: the uid header, a username-header fallback, or unknown (a pre-upgrade cookie, which has no headers to consult). */
export type SubjectSource = "uid" | "username" | null;

export interface ForwardauthSubject {
	/** Stable identifier used as the (provider, subject) lookup key. */
	subject: string;
	/** Display username from the configured username header. */
	username: string;
	source: "uid" | "username";
}

/**
 * Defensive guard against an abnormally long subject value reaching the DB.
 * Shared by the bridge and the inline forwardauth path (previously only the
 * bridge carried this check).
 */
const MAX_SUBJECT_LENGTH = 512;

/**
 * Derive {subject, username, source} from a forwardauth header set.
 * Returns null when the username header is absent (not a forwardauth
 * request) or when the resolved subject exceeds MAX_SUBJECT_LENGTH.
 *
 * uid is stable across renames and preferred; when the IdP sends no uid,
 * the username itself is the subject (source: "username") — both the
 * inline path (middleware.ts) and the bridge now go through this one
 * helper, closing the drift where the inline path previously used uid-only
 * while the bridge used `uid || username`.
 */
export function forwardauthSubject(headers: Headers): ForwardauthSubject | null {
	const username = headers.get(config.forwardauthHeader("username"));
	if (!username) return null;

	const uid = headers.get(config.forwardauthHeader("uid"));
	const subject = uid || username;
	if (subject.length > MAX_SUBJECT_LENGTH) return null;

	return { subject, username, source: uid ? "uid" : "username" };
}

/**
 * The configured forwardauth provider label is encoded directly into the
 * synthetic SSO username ("sso:" + provider + ":" + subject). A provider
 * containing ":" would make that encoding ambiguous (there would be no way
 * to tell where the provider ends and the subject begins), and an empty or
 * whitespace-only provider would collide with every other misconfigured
 * install. Refuse to boot rather than risk that.
 */
export function validateForwardauthProviderConfig(): void {
	const provider = config.forwardauthProvider;
	if (!provider.trim()) {
		throw new Error("FORWARDAUTH_PROVIDER must not be empty or whitespace-only.");
	}
	if (provider.includes(":")) {
		throw new Error(
			`FORWARDAUTH_PROVIDER must not contain ":" (got "${provider}") — it is encoded into the SSO username as "sso:<provider>:<subject>", and a colon in the provider would make that encoding ambiguous.`,
		);
	}
}

export interface ResolvedSsoUser {
	id: string;
	role: "user" | "admin";
	disabled: boolean;
	mustChangePassword: boolean;
	/** From the username header at creation; null for local rows unless set. Never the stored "sso:..." username — callers fall back to their own label when null. */
	displayName: string | null;
}

/**
 * Resolve (or create) the `users` row for an SSO identity.
 *
 * - First resolve for a (provider, subject) pair creates exactly one row.
 * - A second concurrent first resolve hits the unique index; the loser
 *   re-selects once rather than throwing (never throws for a normal race).
 * - A disabled row is returned as disabled and is never recreated or
 *   un-disabled here.
 * - subject_source is written at creation; a later call whose row has a
 *   null subject_source and a non-null incoming source fills it once. A
 *   non-null subject_source is never changed (env-admin promotion needs a
 *   stable, persisted source).
 */
export async function resolveSsoUser(input: {
	provider: string;
	subject: string;
	source: SubjectSource;
	username: string;
}): Promise<ResolvedSsoUser> {
	const existing = await selectByProviderSubject(input.provider, input.subject);
	if (existing) {
		await fillSubjectSourceOnce(existing, input.source);
		return toResolved(await promoteIfListed(existing, input));
	}

	const now = new Date().toISOString();
	const sentinelUsername = `sso:${input.provider}:${input.subject}`;
	const [inserted] = await getDb()
		.insert(users)
		.values({
			username: sentinelUsername,
			passwordHash: "!",
			role: "user",
			authSource: "forwardauth",
			provider: input.provider,
			subject: input.subject,
			subjectSource: input.source,
			displayName: input.username,
			createdAt: now,
			updatedAt: now,
		})
		// No target: the deterministic sentinel username ("sso:" + provider +
		// ":" + subject) means a genuine concurrent race can violate EITHER
		// the (provider, subject) index or the username index first,
		// depending on timing — Postgres only suppresses a conflict against
		// the exact arbiter index named in ON CONFLICT, so naming just one
		// left the other race window open (surfaced under Postgres's real
		// connection-level concurrency; SQLite's single connection masked
		// it). A bare ON CONFLICT DO NOTHING suppresses either.
		.onConflictDoNothing()
		.returning();

	if (inserted) return toResolved(await promoteIfListed(inserted, input));

	// Lost the race: another caller's insert won. Re-select once. Safe to
	// key on (provider, subject) regardless of which index caused the
	// no-op: a username collision can only happen between two inserts for
	// this exact (provider, subject) pair, since the username is derived
	// deterministically from them.
	const row = await selectByProviderSubject(input.provider, input.subject);
	if (!row) {
		// Should be unreachable (the conflicting insert committed before ours
		// returned zero rows), but never throw for a normal race.
		throw new Error(
			`[user-identity] resolveSsoUser: no row found for (${input.provider}, ${input.subject}) after a conflicting insert`,
		);
	}
	await fillSubjectSourceOnce(row, input.source);
	return toResolved(await promoteIfListed(row, input));
}

/**
 * Whether this request's identity entitles the row to admin through
 * AGENTPULSE_ADMIN_SSO_SUBJECTS. Every condition is in memory — the
 * steady-state request (already admin, or not listed) adds no statement and
 * never touches the admin lock:
 *  - the row isn't admin already and isn't disabled;
 *  - the row's PERSISTED subject source is "uid" (not null, not "username":
 *    a username can be recycled to another person) — judged on the row as
 *    read, so a null-sourced row is promoted only after a header request
 *    has filled its source;
 *  - this REQUEST's subject also came from the uid header (a cookie has no
 *    headers; a username-header request has no uid);
 *  - the row belongs to the configured provider and its subject is listed.
 */
function isEntitledToEnvAdmin(row: UserRow, input: { provider: string; source: SubjectSource }) {
	return (
		row.role !== "admin" &&
		row.disabledAt === null &&
		row.subjectSource === "uid" &&
		input.source === "uid" &&
		input.provider === config.forwardauthProvider &&
		row.subject !== null &&
		config.adminSsoSubjects.includes(row.subject)
	);
}

/**
 * Compare-then-write promotion: under the admin lock, one conditional update
 * (member → admin, still active); only the call whose update changed the row
 * logs, so simultaneous first requests promote once and log once. Returns the
 * row as it stands afterwards. Removing a subject from the list later never
 * demotes — nothing here runs for a row that is already admin.
 */
async function promoteIfListed(
	row: UserRow,
	input: { provider: string; source: SubjectSource },
): Promise<UserRow> {
	if (!isEntitledToEnvAdmin(row, input)) return row;

	const { promoted, current } = await withAdminLock(async (tx) => {
		const updated = await tx
			.update(users)
			.set({ role: "admin", updatedAt: new Date().toISOString() })
			.where(and(eq(users.id, row.id), ne(users.role, "admin"), isNull(users.disabledAt)))
			.returning();
		if (updated.length > 0) return { promoted: true, current: updated[0] as UserRow };
		const [reread] = await tx.select().from(users).where(eq(users.id, row.id)).limit(1);
		return { promoted: false, current: (reread ?? row) as UserRow };
	});

	if (promoted) {
		console.log(
			JSON.stringify({
				kind: "admin_promoted",
				level: "info",
				userId: row.id,
				via: "env",
				subjectSource: "uid",
			}),
		);
	}
	return current;
}

/** Fetch {id, role, disabled, mustChangePassword} for any active-or-not user row by id. Used for both local and SSO rows. */
export async function getActiveUser(userId: string): Promise<ResolvedSsoUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
	return row ? toResolved(row) : null;
}

export interface UserGateState {
	disabled: boolean;
	mustChangePassword: boolean;
}

/**
 * Batched {disabled, mustChangePassword} lookup for a set of user ids — one
 * statement regardless of how many ids are passed. Used by the WebSocket
 * heartbeat sweep, which must re-check every connected user's gate
 * state on each tick without issuing one query per connection. A user id
 * with no matching row (deleted) is simply absent from the returned map;
 * callers that need "is this a known user" treat absence as "nothing to do"
 * rather than as disabled.
 */
export async function getUserGateStates(userIds: string[]): Promise<Map<string, UserGateState>> {
	const result = new Map<string, UserGateState>();
	if (userIds.length === 0) return result;
	const rows = await getDb()
		.select({
			id: users.id,
			disabledAt: users.disabledAt,
			mustChangePassword: users.mustChangePassword,
		})
		.from(users)
		.where(inArray(users.id, userIds));
	for (const row of rows) {
		result.set(row.id, {
			disabled: row.disabledAt !== null,
			mustChangePassword: row.mustChangePassword,
		});
	}
	return result;
}

type UserRow = typeof users.$inferSelect;

async function selectByProviderSubject(provider: string, subject: string): Promise<UserRow | null> {
	const [row] = await getDb()
		.select()
		.from(users)
		.where(and(eq(users.provider, provider), eq(users.subject, subject)))
		.limit(1);
	return row ?? null;
}

/** Fills subject_source once (null → a non-null source). Never overwrites a non-null value. */
async function fillSubjectSourceOnce(row: UserRow, source: SubjectSource): Promise<void> {
	if (row.subjectSource !== null || source === null) return;
	await getDb()
		.update(users)
		.set({ subjectSource: source, updatedAt: new Date().toISOString() })
		.where(eq(users.id, row.id));
}

function toResolved(row: UserRow): ResolvedSsoUser {
	return {
		id: row.id,
		role: row.role as "user" | "admin",
		disabled: row.disabledAt !== null,
		mustChangePassword: row.mustChangePassword,
		displayName: row.displayName,
	};
}
