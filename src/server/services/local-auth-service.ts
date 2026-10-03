import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { authSessions, users } from "../db/schema/index.js";
import { resolveSsoUser } from "./user-identity.js";

/**
 * Local-account auth: username + argon2id password + cookie-backed
 * sessions. Coexists with the existing Authentik forwardauth and API
 * key paths in `auth/middleware.ts`. The canonical cookie name is
 * `ap_session`; each session row keys on SHA-256(token) so leaking a DB
 * row cannot reconstruct the actual cookie.
 */

export const SESSION_COOKIE_NAME = "ap_session";
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** SSO sessions are short-lived (default 8h). Env-tunable: AGENTPULSE_SSO_SESSION_DURATION_MS. */
export const SSO_SESSION_DURATION_MS = process.env.AGENTPULSE_SSO_SESSION_DURATION_MS
	? Number(process.env.AGENTPULSE_SSO_SESSION_DURATION_MS)
	: 8 * 60 * 60 * 1000; // 8 hours

export interface LocalUser {
	id: string;
	username: string;
	role: "user" | "admin";
	disabledAt: string | null;
	lastLoginAt: string | null;
	createdAt: string;
	updatedAt: string;
	/** "local" | "forwardauth". A LocalUser returned from a local-only lookup is always "local". */
	authSource: string;
	mustChangePassword: boolean;
}

function toUser(row: typeof users.$inferSelect): LocalUser {
	return {
		id: row.id,
		username: row.username,
		role: row.role as "user" | "admin",
		disabledAt: row.disabledAt,
		lastLoginAt: row.lastLoginAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		authSource: row.authSource,
		mustChangePassword: row.mustChangePassword,
	};
}

/**
 * Count active (non-disabled) LOCAL users. SSO-bridged rows (auth_source =
 * "forwardauth") never count here — a synthetic operator row must not close
 * first-run signup, and the bootstrap admin lookup is local-only.
 */
export async function countActiveUsers(): Promise<number> {
	const rows = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(and(isNull(users.disabledAt), eq(users.authSource, "local")));
	return rows.length;
}

export async function getUserByUsername(username: string): Promise<LocalUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
	return row ? toUser(row) : null;
}

/**
 * Local-only username lookup. Used by the bootstrap admin sync, which must
 * never rewrite a non-local (SSO) row that happens to collide with the
 * configured bootstrap username.
 */
export async function getLocalUserByUsername(username: string): Promise<LocalUser | null> {
	const [row] = await getDb()
		.select()
		.from(users)
		.where(and(eq(users.username, username), eq(users.authSource, "local")))
		.limit(1);
	return row ? toUser(row) : null;
}

export async function getUserById(id: string): Promise<LocalUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	return row ? toUser(row) : null;
}

export interface CreateUserInput {
	username: string;
	password: string;
	role?: "user" | "admin";
	/**
	 * True when someone other than the user chose the password (an admin
	 * creating the account), so the user must replace it before doing
	 * anything else. Self-signup and the bootstrap admin leave it false.
	 */
	mustChangePassword?: boolean;
}

export async function createUser(input: CreateUserInput): Promise<LocalUser> {
	validateUsername(input.username);
	validatePassword(input.password);
	const passwordHash = await Bun.password.hash(input.password, {
		algorithm: "argon2id",
	});
	const now = new Date().toISOString();
	const [row] = await getDb()
		.insert(users)
		.values({
			username: input.username,
			passwordHash,
			role: input.role ?? "user",
			authSource: "local",
			mustChangePassword: input.mustChangePassword ?? false,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toUser(row);
}

/**
 * Verify username + password. Returns null on any failure — caller
 * cannot distinguish "wrong username" from "wrong password" from the
 * return value, which is the point.
 *
 * Explicitly rejects a non-local (SSO) row even though its password_hash
 * ("!") would never verify anyway — the explicit check pins the rejection
 * so a future change to the sentinel value can't silently reopen SSO-row
 * login.
 */
export async function verifyCredentials(
	username: string,
	password: string,
): Promise<LocalUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
	if (!row || row.authSource !== "local" || row.disabledAt) {
		// Run a real verify against a known-good dummy hash so that
		// "user not found", "not a local account", and "disabled" all take
		// similar time to "wrong password" — none of them should be
		// distinguishable from a timing side channel.
		const dummy = await getDummyHash();
		await Bun.password.verify(password, dummy).catch(() => false);
		return null;
	}
	const ok = await Bun.password.verify(password, row.passwordHash).catch(() => false);
	if (!ok) return null;
	const now = new Date().toISOString();
	await getDb().update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, row.id));
	return toUser(row);
}

/** Rehash a user's password. Caller must already be authenticated as this user. */
export async function changeUserPassword(input: {
	userId: string;
	currentPassword: string;
	newPassword: string;
}): Promise<boolean> {
	const [row] = await getDb().select().from(users).where(eq(users.id, input.userId)).limit(1);
	if (!row || row.authSource !== "local") return false;
	const ok = await Bun.password.verify(input.currentPassword, row.passwordHash).catch(() => false);
	if (!ok) return false;
	validatePassword(input.newPassword);
	const newHash = await Bun.password.hash(input.newPassword, { algorithm: "argon2id" });
	const now = new Date().toISOString();
	await getDb()
		.update(users)
		.set({ passwordHash: newHash, mustChangePassword: false, updatedAt: now })
		.where(eq(users.id, input.userId));
	// Invalidate all existing sessions except the caller's (we don't know the caller's token here,
	// so simpler path: invalidate everything; the caller gets a fresh cookie via issueSession).
	await getDb().delete(authSessions).where(eq(authSessions.userId, input.userId));
	return true;
}

// -- sessions ---------------------------------------------------------------

export interface IssuedSession {
	token: string;
	tokenHash: string;
	expiresAt: string;
}

/**
 * Discriminated-union result from resolveSessionByToken.
 * Callers (e.g. getAuthUserFromHeaders step-2) branch on `kind` and map to
 * AuthUser without needing to import AuthUser here (no circular dep).
 */
export type SessionResolution =
	| { kind: "local"; user: LocalUser }
	| {
			kind: "sso";
			subject: string;
			username: string;
			provider: string;
			userId: string;
			role: "user" | "admin";
			mustChangePassword: boolean;
			displayName: string | null;
	  };

/**
 * The session row's own identity fields, with no identity resolve —
 * no resolveSsoUser call, no touch of the users table at all. Used by the
 * forwardauth bridge's "does this cookie already match the current
 * request's subject and provider?" check, which only needs to compare
 * these columns and must not pay for a full resolve just to decide whether
 * a fresh mint is needed.
 */
export type SessionIdentityPeek =
	| { kind: "local" }
	| { kind: "sso"; subject: string; username: string; provider: string };

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a new session. Returns the raw token (caller sets it in a cookie).
 *
 * Local sessions:   issueSession({ userId, userAgent })
 * SSO sessions:     issueSession({ userId:<resolveSsoUser(...).id>, durationMs:SSO_SESSION_DURATION_MS,
 *                                  authSource:"forwardauth", ssoSubject, ssoUsername, provider })
 *
 * auth_sessions.user_id stores the real users.id for SSO sessions too —
 * the caller resolves it via resolveSsoUser() before calling issueSession().
 * A pre-upgrade row may still carry the old "sso:" + subject literal;
 * resolveSessionByToken's SSO branch re-resolves by (provider, subject) on
 * every read, so that literal is never parsed as an id.
 *
 * `durationMs` defaults to SESSION_DURATION_MS (30d) so existing callers are
 * unaffected. The SSO bridge passes SSO_SESSION_DURATION_MS (8h).
 */
export async function issueSession(input: {
	userId: string;
	userAgent?: string | null;
	/** Defaults to SESSION_DURATION_MS (30d). Pass SSO_SESSION_DURATION_MS for SSO sessions. */
	durationMs?: number;
	/** Defaults to "local". Pass "forwardauth" for SSO sessions. */
	authSource?: string;
	/** SSO subject identifier (stable across renames). Null for local sessions. */
	ssoSubject?: string | null;
	/** SSO display username. Null for local sessions. */
	ssoUsername?: string | null;
	/** Forwardauth provider label (e.g. "authentik"). Null for local sessions. */
	provider?: string | null;
}): Promise<IssuedSession> {
	const token = randomBytes(32).toString("hex");
	const tokenHash = hashToken(token);
	const durationMs = input.durationMs ?? SESSION_DURATION_MS;
	const expiresAt = new Date(Date.now() + durationMs).toISOString();
	const now = new Date().toISOString();
	await getDb()
		.insert(authSessions)
		.values({
			tokenHash,
			userId: input.userId,
			expiresAt,
			userAgent: input.userAgent ?? null,
			createdAt: now,
			lastSeenAt: now,
			authSource: input.authSource ?? "local",
			ssoSubject: input.ssoSubject ?? null,
			ssoUsername: input.ssoUsername ?? null,
			provider: input.provider ?? null,
		});
	return { token, tokenHash, expiresAt };
}

type AuthSessionRow = typeof authSessions.$inferSelect;

/**
 * Shared prefix for both resolveSessionByToken and peekSessionIdentity:
 * hash lookup, expiry check (deleting an expired row), and the last-seen
 * touch. Two statements (the select, then either the delete or the
 * update) — identical for every caller, resolved or not.
 */
async function readAndTouchSessionRow(token: string): Promise<AuthSessionRow | null> {
	if (!token) return null;
	const tokenHash = hashToken(token);
	const [row] = await getDb()
		.select()
		.from(authSessions)
		.where(eq(authSessions.tokenHash, tokenHash))
		.limit(1);
	if (!row) return null;
	const now = new Date();
	if (new Date(row.expiresAt) <= now) {
		await getDb().delete(authSessions).where(eq(authSessions.tokenHash, tokenHash));
		return null;
	}
	// Touch last-seen timestamp; cheap write that doubles as usage telemetry.
	await getDb()
		.update(authSessions)
		.set({ lastSeenAt: now.toISOString() })
		.where(eq(authSessions.tokenHash, tokenHash));
	return row;
}

/**
 * Read a session row's own identity columns without resolving it — see
 * SessionIdentityPeek. Callers that need the full, authoritative identity
 * (including the disabled check) must use resolveSessionByToken instead;
 * this is for a cheap "does this match?" comparison only.
 */
export async function peekSessionIdentity(token: string): Promise<SessionIdentityPeek | null> {
	const row = await readAndTouchSessionRow(token);
	if (!row) return null;
	if (row.authSource === "forwardauth") {
		if (!row.ssoSubject) return null;
		return {
			kind: "sso",
			subject: row.ssoSubject,
			username: row.ssoUsername ?? "",
			provider: row.provider ?? "",
		};
	}
	return { kind: "local" };
}

/**
 * Resolve a raw cookie token to a typed session record.
 *
 * Returns:
 *   - `{ kind:"local", user }` — token belongs to a local-account session.
 *   - `{ kind:"sso", subject, username, provider }` — token belongs to an SSO-bridged session.
 *   - `null` — token missing, unknown, or expired (expired rows are deleted on read).
 *
 * This is the single step-2 chokepoint: getAuthUserFromHeaders, the WS path,
 * and requireAuth all inherit SSO-cookie resolution through this function.
 * Never import AuthUser here — map at the call site to avoid a circular dep
 * with auth/middleware.ts.
 */
export async function resolveSessionByToken(token: string): Promise<SessionResolution | null> {
	const row = await readAndTouchSessionRow(token);
	if (!row) return null;

	if (row.authSource === "forwardauth") {
		// A subject-less SSO row is malformed — it would produce AuthUser.id === ""
		// downstream, which is an invalid identity (xander L-2). Treat the row as
		// unresolvable rather than emit a subject-less SSO identity.
		if (!row.ssoSubject) return null;
		// Resolve (or create, for a pre-upgrade row that predates any `users`
		// row) the real users.id for this SSO identity. This is a cookie-only
		// path — no forwardauth headers are available here — so the source is
		// unknown: a null subject_source at creation, filled once by a later
		// header-path resolve.
		const resolved = await resolveSsoUser({
			provider: row.provider ?? "",
			subject: row.ssoSubject,
			source: null,
			username: row.ssoUsername ?? "",
		});
		if (resolved.disabled) return null;
		return {
			kind: "sso",
			subject: row.ssoSubject,
			username: row.ssoUsername ?? "",
			provider: row.provider ?? "",
			userId: resolved.id,
			role: resolved.role,
			mustChangePassword: resolved.mustChangePassword,
			displayName: resolved.displayName,
		};
	}

	// Local session — fetch the user row (may be null if the user was deleted
	// or disabled). A disabled user's cookie must not resolve.
	const user = await getUserById(row.userId);
	if (!user || user.disabledAt) return null;
	return { kind: "local", user };
}

export async function revokeSessionByToken(token: string): Promise<void> {
	if (!token) return;
	await getDb()
		.delete(authSessions)
		.where(eq(authSessions.tokenHash, hashToken(token)));
}

/**
 * Admin action: revoke every session for a given user. Accepts an optional
 * transaction handle so callers running inside withAdminLock issue
 * this delete on the same tx as the rest of their sequence, rather than a
 * fresh getDb() connection that would commit independently of a later
 * rollback.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function revokeAllSessionsForUser(userId: string, tx?: any): Promise<void> {
	await (tx ?? getDb()).delete(authSessions).where(eq(authSessions.userId, userId));
}

/** Sweep expired rows. Called on a timer; also runs lazily on each read. */
export async function reapExpiredSessions(): Promise<number> {
	const rows = await getDb()
		.delete(authSessions)
		.where(lte(authSessions.expiresAt, new Date().toISOString()))
		.returning();
	return rows.length;
}

// -- validation ------------------------------------------------------------

const USERNAME_RE = /^[a-zA-Z0-9_\-.]{2,64}$/;

/**
 * Validates a local username. Exported so callers (and tests) can pin that
 * this pattern — which excludes ":" — is what stops a local account being
 * named "sso:..." and colliding with the SSO username convention.
 */
export function validateUsername(u: string): void {
	if (!USERNAME_RE.test(u)) {
		throw new Error("Invalid username. Use 2–64 chars: letters, digits, _ - .");
	}
}

function validatePassword(p: string): void {
	if (typeof p !== "string" || p.length < 12) {
		throw new Error("Password must be at least 12 characters.");
	}
	if (p.length > 1024) {
		throw new Error("Password is too long.");
	}
}

// Lazy argon2id hash used purely for timing parity when the username
// doesn't exist. Computed once; never matched against.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
	if (!dummyHashPromise) {
		dummyHashPromise = Bun.password.hash("dummy-password-do-not-match", {
			algorithm: "argon2id",
		});
	}
	return dummyHashPromise;
}
