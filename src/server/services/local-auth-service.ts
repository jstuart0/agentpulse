import { createHash, randomBytes } from "node:crypto";
import { eq, isNull, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { authSessions, users } from "../db/schema/index.js";

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
	};
}

/** Count active (non-disabled) local users. */
export async function countActiveUsers(): Promise<number> {
	const rows = await getDb().select({ id: users.id }).from(users).where(isNull(users.disabledAt));
	return rows.length;
}

export async function getUserByUsername(username: string): Promise<LocalUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
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
 */
export async function verifyCredentials(
	username: string,
	password: string,
): Promise<LocalUser | null> {
	const [row] = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
	if (!row) {
		// Run a real verify against a known-good dummy hash so the
		// "user not found" path takes similar time to "wrong password".
		const dummy = await getDummyHash();
		await Bun.password.verify(password, dummy).catch(() => false);
		return null;
	}
	if (row.disabledAt) return null;
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
	if (!row) return false;
	const ok = await Bun.password.verify(input.currentPassword, row.passwordHash).catch(() => false);
	if (!ok) return false;
	validatePassword(input.newPassword);
	const newHash = await Bun.password.hash(input.newPassword, { algorithm: "argon2id" });
	const now = new Date().toISOString();
	await getDb()
		.update(users)
		.set({ passwordHash: newHash, updatedAt: now })
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
	| { kind: "sso"; subject: string; username: string; provider: string };

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a new session. Returns the raw token (caller sets it in a cookie).
 *
 * Local sessions:   issueSession({ userId, userAgent })
 * SSO sessions:     issueSession({ userId:"sso:"+subject, durationMs:SSO_SESSION_DURATION_MS,
 *                                  authSource:"forwardauth", ssoSubject, ssoUsername, provider })
 *
 * `durationMs` defaults to SESSION_DURATION_MS (30d) so existing callers are
 * unaffected. The SSO bridge (Phase 4) passes SSO_SESSION_DURATION_MS (8h).
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

	if (row.authSource === "forwardauth") {
		// A subject-less SSO row is malformed — it would produce AuthUser.id === ""
		// downstream, which is an invalid identity (xander L-2). Treat the row as
		// unresolvable rather than emit a subject-less SSO identity.
		if (!row.ssoSubject) return null;
		return {
			kind: "sso",
			subject: row.ssoSubject,
			username: row.ssoUsername ?? "",
			provider: row.provider ?? "",
		};
	}

	// Local session — fetch the user row (may be null if the user was deleted).
	const user = await getUserById(row.userId);
	if (!user) return null;
	return { kind: "local", user };
}

export async function revokeSessionByToken(token: string): Promise<void> {
	if (!token) return;
	await getDb()
		.delete(authSessions)
		.where(eq(authSessions.tokenHash, hashToken(token)));
}

/** Admin action: revoke every session for a given user. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
	await getDb().delete(authSessions).where(eq(authSessions.userId, userId));
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

function validateUsername(u: string): void {
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
