import { randomBytes } from "node:crypto";
/**
 * Admin-surface user management: role changes, disable/enable,
 * password reset. Every write here runs inside withAdminLock so two
 * admins acting at the same instant can never both leave the instance with
 * zero admins.
 */
import { type SQL, eq, ne, sql } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { deactivateApiKeysOwnedByUser } from "../auth/api-key.js";
import {
	deactivateEnrollmentTokensCreatedByUser,
	revokeSupervisorCredential,
} from "../auth/supervisor-auth.js";
import { config } from "../config.js";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, supervisors, users } from "../db/schema/index.js";
import { closeSocketsForUser } from "../ws/handler.js";
import {
	type LocalUser,
	createUser,
	getUserByUsername,
	revokeAllSessionsForUser,
} from "./local-auth-service.js";
import { listSupervisorIdsOwnedByUser, revokeSupervisor } from "./supervisor-registry.js";

export class LastAdminError extends Error {
	constructor() {
		super("Cannot disable or demote the last active admin.");
		this.name = "LastAdminError";
	}
}

export class RoleLockedByEnvError extends Error {
	constructor() {
		super("This admin's role is set by AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be changed here.");
		this.name = "RoleLockedByEnvError";
	}
}

export class NotLocalAccountError extends Error {
	constructor() {
		super("Password reset is only available for local accounts.");
		this.name = "NotLocalAccountError";
	}
}

export class UsernameTakenError extends Error {
	constructor(username: string) {
		super(`The username "${username}" is already taken.`);
		this.name = "UsernameTakenError";
	}
}

export class UserNotFoundError extends Error {
	constructor(userId: string) {
		super(`User not found: ${userId}`);
		this.name = "UserNotFoundError";
	}
}

/**
 * True when a user's admin role is locked by AGENTPULSE_ADMIN_SSO_SUBJECTS —
 * an env-promoted SSO admin can't be demoted through the UI. Matches on
 * provider as well as subject: the env lists subjects of the configured
 * forwardauth provider, and the same string under another provider is a
 * different person.
 */
export function isRoleLockedByEnv(row: {
	authSource: string;
	role: string;
	provider: string | null;
	subject: string | null;
	subjectSource: string | null;
}): boolean {
	if (row.authSource !== "forwardauth" || row.role !== "admin") return false;
	if (row.subjectSource !== "uid" || !row.subject) return false;
	if (row.provider !== config.forwardauthProvider) return false;
	return config.adminSsoSubjects.includes(row.subject);
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function countActiveAdminsExcluding(tx: any, excludedUserId: string | null): Promise<number> {
	const rows = await tx.select().from(users).where(eq(users.role, "admin"));
	return rows.filter(
		(r: { id: string; disabledAt: string | null }) =>
			r.disabledAt === null && r.id !== excludedUserId,
	).length;
}

export interface SetUserRoleResult {
	user: LocalUser;
}

/** Change a user's role. Refuses to demote the last active admin or an env-locked one. Runs under the admin lock. */
export async function setUserRole(
	targetUserId: string,
	role: "user" | "admin",
	_actor: Actor,
): Promise<SetUserRoleResult> {
	return withAdminLock(async (tx) => {
		const [row] = await tx.select().from(users).where(eq(users.id, targetUserId)).limit(1);
		if (!row) throw new UserNotFoundError(targetUserId);

		if (role === "user" && row.role === "admin") {
			if (isRoleLockedByEnv(row)) throw new RoleLockedByEnvError();
			const remainingAdmins = await countActiveAdminsExcluding(tx, targetUserId);
			if (remainingAdmins === 0 && row.disabledAt === null) {
				throw new LastAdminError();
			}
		}

		const now = new Date().toISOString();
		const [updated] = await tx
			.update(users)
			.set({ role, updatedAt: now })
			.where(eq(users.id, targetUserId))
			.returning();

		return { user: toLocalUser(updated) };
	});
}

export interface DisableUserOptions {
	/** Default true: also revoke every supervisor (host) the user owns. */
	revokeHosts?: boolean;
}

/**
 * Disable a user: sets disabled_at, deletes their sessions, deactivates
 * their keys, and (by default) revokes every host they own. Then closes
 * their open WebSocket connections. Refuses to disable the last active
 * admin or an env-locked one. Runs under the admin lock.
 */
export async function disableUser(
	targetUserId: string,
	opts: DisableUserOptions,
	_actor: Actor,
): Promise<void> {
	await withAdminLock(async (tx) => {
		const [row] = await tx.select().from(users).where(eq(users.id, targetUserId)).limit(1);
		if (!row) throw new UserNotFoundError(targetUserId);
		if (row.disabledAt !== null) return; // already disabled — idempotent no-op

		if (row.role === "admin") {
			if (isRoleLockedByEnv(row)) throw new RoleLockedByEnvError();
			const remainingAdmins = await countActiveAdminsExcluding(tx, targetUserId);
			if (remainingAdmins === 0) throw new LastAdminError();
		}

		const now = new Date().toISOString();
		await tx
			.update(users)
			.set({ disabledAt: now, updatedAt: now })
			.where(eq(users.id, targetUserId));
		await revokeAllSessionsForUser(targetUserId, tx);
		await deactivateApiKeysOwnedByUser(targetUserId, tx);
		await deactivateEnrollmentTokensCreatedByUser(targetUserId, tx);

		await _disableUserStepHookForTest?.("credentials-deactivated");

		if (opts.revokeHosts !== false) {
			const supervisorIds = await listSupervisorIdsOwnedByUser(targetUserId, tx);
			for (const supervisorId of supervisorIds) {
				await revokeSupervisor(supervisorId, tx);
				await revokeSupervisorCredential(supervisorId, tx);
			}
		}
		await _disableUserStepHookForTest?.("hosts-revoked");
	});

	// Socket teardown happens after the lock/transaction commits — closing a
	// connection is not a DB write and must not be rolled back alongside one
	// (nor should an in-memory close block the lock's release).
	closeSocketsForUser(targetUserId);
}

/** Clear disabled_at only. Does not restore revoked keys or hosts. Runs under the admin lock. */
export async function enableUser(targetUserId: string, _actor: Actor): Promise<void> {
	await withAdminLock(async (tx) => {
		const [row] = await tx.select().from(users).where(eq(users.id, targetUserId)).limit(1);
		if (!row) throw new UserNotFoundError(targetUserId);
		await tx
			.update(users)
			.set({ disabledAt: null, updatedAt: new Date().toISOString() })
			.where(eq(users.id, targetUserId));
	});
}

export interface ResetPasswordResult {
	password: string;
}

/**
 * Admin reset-password: local users only. Generates a new password, sets
 * must_change_password, deletes the user's sessions, and closes their
 * sockets. Runs under the admin lock. Password hashing happens before the
 * lock is taken (precedent: routes/auth.ts's signup flow).
 */
export async function resetUserPassword(
	targetUserId: string,
	_actor: Actor,
): Promise<ResetPasswordResult> {
	// generatePassword() always produces a 32-character value, well within
	// local-auth-service's 12-1024 char bounds — no separate validation call.
	const password = generatePassword();
	const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });

	await withAdminLock(async (tx) => {
		const [row] = await tx.select().from(users).where(eq(users.id, targetUserId)).limit(1);
		if (!row) throw new UserNotFoundError(targetUserId);
		if (row.authSource !== "local") throw new NotLocalAccountError();
		const now = new Date().toISOString();
		await tx
			.update(users)
			.set({ passwordHash, mustChangePassword: true, updatedAt: now })
			.where(eq(users.id, targetUserId));
		await revokeAllSessionsForUser(targetUserId, tx);
	});

	closeSocketsForUser(targetUserId);
	return { password };
}

export interface CreatedUser {
	user: LocalUser;
	/** The generated one-time password. Shown once, never stored in the clear, never logged. */
	password: string;
}

/**
 * Admin-created local account: a generated password the admin hands over once,
 * and a flag that makes the user replace it before doing anything else.
 */
export async function createUserWithGeneratedPassword(
	input: { username: string; role: "user" | "admin" },
	_actor: Actor,
): Promise<CreatedUser> {
	if (await getUserByUsername(input.username)) throw new UsernameTakenError(input.username);
	const password = generatePassword();
	const user = await createUser({
		username: input.username,
		password,
		role: input.role,
		mustChangePassword: true,
	});
	return { user, password };
}

export interface UserDirectoryEntry {
	id: string;
	displayName: string | null;
	disabled: boolean;
	/** Where the name comes from: a local login name, or an identity provider's display name. */
	authSource: "local" | "sso";
}

/**
 * Everyone who can own something, for a person picker: id, a label, whether
 * they're disabled and whether the label is a login or a provider's display
 * name, nothing else. A local account's label is its username; an
 * SSO account's is its display name (never the stored "sso:..." username).
 */
export async function listUserDirectory(): Promise<UserDirectoryEntry[]> {
	const rows = await getDb().select().from(users).orderBy(users.createdAt);
	return rows.map((row) => ({
		id: row.id,
		displayName: row.authSource === "local" ? row.username : row.displayName,
		disabled: row.disabledAt !== null,
		authSource: row.authSource === "local" ? "local" : "sso",
	}));
}

export interface UserDirectoryRow {
	id: string;
	username: string;
	displayName: string | null;
	role: "user" | "admin";
	disabled: boolean;
	authSource: string;
	provider: string | null;
	subjectSource: "uid" | "username" | null;
	lastLoginAt: string | null;
	roleLockedByEnv: boolean;
	mustChangePassword: boolean;
	/** Active API keys they own. */
	keyCount: number;
	/** Hosts they own that haven't been revoked. */
	hostCount: number;
	/** Sessions they own, archived or not. */
	sessionCount: number;
}

async function countByOwner(
	table: typeof apiKeys | typeof supervisors | typeof sessions,
	owner: typeof apiKeys.ownerUserId | typeof supervisors.ownerUserId | typeof sessions.ownerUserId,
	where: SQL | undefined,
): Promise<Map<string, number>> {
	const rows = await getDb()
		.select({ owner, count: sql<number>`count(*)`.mapWith(Number) })
		.from(table)
		.where(where)
		.groupBy(owner);
	return new Map(
		rows
			.filter((row: { owner: string | null }) => row.owner !== null)
			.map((row: { owner: string | null; count: number }) => [row.owner as string, row.count]),
	);
}

/** GET /users: admin, both modes. Never exposes password hashes or key/session material. */
export async function listUsersForAdmin(): Promise<UserDirectoryRow[]> {
	const rows = await getDb().select().from(users).orderBy(users.createdAt);
	const keyCounts = await countByOwner(apiKeys, apiKeys.ownerUserId, eq(apiKeys.isActive, true));
	const hostCounts = await countByOwner(
		supervisors,
		supervisors.ownerUserId,
		ne(supervisors.enrollmentState, "revoked"),
	);
	const sessionCounts = await countByOwner(sessions, sessions.ownerUserId, undefined);
	return rows.map((row) => ({
		id: row.id,
		username: row.authSource === "local" ? row.username : (row.displayName ?? "User"),
		displayName: row.displayName,
		role: row.role as "user" | "admin",
		disabled: row.disabledAt !== null,
		authSource: row.authSource,
		provider: row.provider,
		subjectSource: row.subjectSource as "uid" | "username" | null,
		lastLoginAt: row.lastLoginAt,
		roleLockedByEnv: isRoleLockedByEnv(row),
		mustChangePassword: row.mustChangePassword,
		keyCount: keyCounts.get(row.id) ?? 0,
		hostCount: hostCounts.get(row.id) ?? 0,
		sessionCount: sessionCounts.get(row.id) ?? 0,
	}));
}

function toLocalUser(row: typeof users.$inferSelect): LocalUser {
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

function generatePassword(): string {
	// 24 random bytes, base64url-encoded: well over the 12-character minimum,
	// no characters that confuse a one-time-copy UI (no padding, no +/).
	return randomBytes(24).toString("base64url");
}

// ── Test-only seam ────────────────────────────────────────────────────────
// Lets admin-lock.test.ts inject a failure partway through disableUser's
// sequence — after the user's keys and enrollment tokens are deactivated,
// and again after their hosts are revoked — to prove every write up to that
// point rolls back together, i.e. that every helper in the sequence really
// does run on the passed tx. Enforced by check-no-test-seam-leaks.ts: this
// export may only be referenced from a *.test.ts file or test-utils/.
export type DisableUserStep = "credentials-deactivated" | "hosts-revoked";

let _disableUserStepHookForTest: ((step: DisableUserStep) => Promise<void>) | null = null;
export function _setDisableUserStepHookForTest(
	hook: ((step: DisableUserStep) => Promise<void>) | null,
): void {
	_disableUserStepHookForTest = hook;
}
