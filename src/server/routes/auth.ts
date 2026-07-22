import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getTrustedClientIp } from "../auth/client-ip.js";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { settings, users } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import {
	SESSION_COOKIE_NAME,
	SESSION_DURATION_MS,
	changeUserPassword,
	countActiveUsers,
	createUser,
	issueSession,
	revokeSessionByToken,
	verifyCredentials,
} from "../services/local-auth-service.js";

// ── Rate limiting (S-H1) ─────────────────────────────────────────────────────
//
// Per-IP+username token bucket. After MAX_FAILURES within WINDOW_MS the bucket
// locks out with exponential backoff starting at BASE_BACKOFF_MS. The bucket
// expires DECAY_MS after the last failure (15 minutes of inactivity clears it).
//
// Storage: in-memory Map. Process-restart clears all buckets; that is
// intentional — this defends against online brute-force, not offline attacks.

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 1 minute observation window for the initial failures
const BASE_BACKOFF_MS = 1_000; // 1 s initial backoff after lockout
const MAX_BACKOFF_MS = 15 * 60 * 1_000; // cap backoff at 15 minutes
const DECAY_MS = 15 * 60 * 1_000; // 15 minutes inactivity → bucket eviction
// Hard cap prevents unbounded Map growth under a distributed enumeration attack
// that generates millions of unique IP+username pairs. When the cap is hit the
// oldest-by-lastFailure entry is evicted first, then the new entry is inserted.
// Evicting oldest means the entry that is most likely already dormant is dropped
// before a fresh attacker; the alternative (refuse insert → allow on a separate
// code path) would be a worse failure mode.
const MAX_BUCKETS = 50_000;

interface RateBucket {
	failures: number;
	/** Timestamp of the first failure in the current window. */
	windowStart: number;
	/** Timestamp after which the next attempt is permitted (0 = not locked). */
	lockedUntil: number;
	/** Timestamp of the last failure (used for decay eviction). */
	lastFailure: number;
}

const rateBuckets = new Map<string, RateBucket>();

/** Evict buckets that have been inactive for DECAY_MS. Called on every check. */
function evictExpiredBuckets(): void {
	const now = Date.now();
	for (const [key, bucket] of rateBuckets) {
		if (now - bucket.lastFailure > DECAY_MS) {
			rateBuckets.delete(key);
		}
	}
}

/**
 * Check whether `key` is currently rate-limited.
 * Returns `null` if the request may proceed, or the number of milliseconds
 * until the next attempt is permitted (for `Retry-After`).
 */
function checkRateLimit(key: string): number | null {
	evictExpiredBuckets();
	const bucket = rateBuckets.get(key);
	if (!bucket) return null;

	const now = Date.now();

	// If locked out, report remaining wait time.
	if (bucket.lockedUntil > now) {
		return Math.ceil((bucket.lockedUntil - now) / 1000);
	}

	// If the observation window has expired, reset. This allows a fresh
	// attempt after WINDOW_MS without a lockout (bucket was below threshold).
	if (now - bucket.windowStart > WINDOW_MS && bucket.failures < MAX_FAILURES) {
		rateBuckets.delete(key);
		return null;
	}

	return null;
}

/**
 * Evict the single oldest bucket (by lastFailure) to make room for a new entry.
 * Called only when `rateBuckets.size >= MAX_BUCKETS`.
 */
function evictOldestBucket(): void {
	let oldestKey: string | undefined;
	let oldestTime = Number.MAX_SAFE_INTEGER;
	for (const [k, b] of rateBuckets) {
		if (b.lastFailure < oldestTime) {
			oldestTime = b.lastFailure;
			oldestKey = k;
		}
	}
	if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
}

/**
 * Record a failed attempt for `key`. Increments the failure counter and,
 * after MAX_FAILURES, applies exponential backoff.
 * Exported for testing only.
 */
export function recordFailure(key: string): void {
	const now = Date.now();
	const existing = rateBuckets.get(key);

	if (!existing) {
		// Enforce the hard size cap before inserting a new entry.
		if (rateBuckets.size >= MAX_BUCKETS) evictOldestBucket();
		rateBuckets.set(key, {
			failures: 1,
			windowStart: now,
			lockedUntil: 0,
			lastFailure: now,
		});
		return;
	}

	existing.failures += 1;
	existing.lastFailure = now;

	if (existing.failures >= MAX_FAILURES) {
		// Exponential backoff: 2^(failures-MAX_FAILURES) × BASE_BACKOFF_MS, capped.
		const exp = existing.failures - MAX_FAILURES;
		const backoff = Math.min(BASE_BACKOFF_MS * 2 ** exp, MAX_BACKOFF_MS);
		existing.lockedUntil = now + backoff;
	}
}

/** Clear the rate-limit bucket for `key` on successful authentication. */
function clearBucket(key: string): void {
	rateBuckets.delete(key);
}

/**
 * Returns the current number of active rate-limit buckets.
 * Exported for testing only — do not call from production code.
 */
export function getRateBucketCount(): number {
	return rateBuckets.size;
}

// ── Password complexity (S-H1 / decision #4) ────────────────────────────────

const PASSWORD_MIN_LEN = 12;

/**
 * Enforce password complexity: ≥12 chars, ≥1 uppercase, ≥1 digit, ≥1 symbol.
 * Returns an error string on failure, or null on success.
 */
export function checkPasswordComplexity(password: string): string | null {
	if (password.length < PASSWORD_MIN_LEN) {
		return `Password must be at least ${PASSWORD_MIN_LEN} characters.`;
	}
	if (!/[A-Z]/.test(password)) {
		return "Password must contain at least one uppercase letter.";
	}
	if (!/[0-9]/.test(password)) {
		return "Password must contain at least one digit.";
	}
	if (!/[^A-Za-z0-9]/.test(password)) {
		return "Password must contain at least one symbol.";
	}
	return null;
}

/**
 * Introspection + local-account auth routes. Local accounts coexist
 * with forwardauth (any IdP) and API-key bearer flows; the priority
 * order lives in `auth/middleware.ts`. When DISABLE_AUTH=true all
 * endpoints here are effectively no-ops because the middleware stamps
 * every request as anonymous upstream.
 */
const authRouter = new Hono();

/**
 * Cookie attributes for `ap_session`. The `durationMs` param lets the Phase 4
 * SSO bridge pass `SSO_SESSION_DURATION_MS` (8h) while all three existing local
 * callers keep passing nothing (defaulting to SESSION_DURATION_MS = 30d).
 */
export function cookieOptions(durationMs = SESSION_DURATION_MS) {
	return {
		path: "/",
		httpOnly: true,
		secure: config.isProduction,
		sameSite: "Lax" as const,
		maxAge: Math.floor(durationMs / 1000),
	};
}

// /auth/me is PUBLIC so the unauthenticated login page can render
// "you're already signed in" states and the client can detect login
// state without a 401 round-trip.
authRouter.get("/auth/me", async (c) => {
	const user = await getAuthUser(c);
	const allowSignup = config.allowSignup && (await countActiveUsers()) === 0;
	if (!user) {
		return c.json({
			authenticated: false,
			user: null,
			signOutUrl: null,
			localAuthEnabled: true,
			allowSignup,
			disableAuth: config.disableAuth,
		});
	}
	// Provider-specific logout URLs. Authentik gets its standard sign-out
	// path; other forwardauth providers return null (the operator wires
	// their own logout endpoint or the UI renders a generic advisory).
	// Local accounts use the API logout endpoint; API-key callers don't
	// need a sign-out URL.
	const signOutUrl =
		user.source === "forwardauth" && user.provider === "authentik"
			? "/outpost.goauthentik.io/sign_out"
			: user.source === "local"
				? "/api/v1/auth/logout"
				: null;
	return c.json({
		authenticated: true,
		user: {
			name: user.name,
			source: user.source,
			provider: user.provider ?? null,
			id: user.id ?? null,
			role: user.role ?? null,
			// AGEN-12 Phase 1: additive. api_key callers only — forwardauth/local
			// callers never carry scopes (AuthUser docstring); JSON.stringify
			// drops the key entirely when undefined, so it's simply absent there.
			scopes: user.scopes,
		},
		signOutUrl,
		localAuthEnabled: true,
		allowSignup: false,
		disableAuth: config.disableAuth,
	});
});

authRouter.post("/auth/login", async (c) => {
	if (config.disableAuth) {
		return c.json({ error: "Auth is disabled on this instance" }, 400);
	}
	const body = await c.req.json<{ username?: string; password?: string }>();
	if (!body.username || !body.password) {
		return c.json({ error: "username and password required" }, 400);
	}
	// Reject oversized usernames before they touch the rate-limit Map.
	// A multi-megabyte key would be stored verbatim for up to DECAY_MS;
	// MAX_BUCKETS caps the count but not per-entry size.
	if (body.username.length > 256) {
		return c.json({ error: "username too long" }, 400);
	}

	// Rate-limit check (S-H1). Key: <client-ip>:<username> so that an attacker
	// spoofing usernames cannot exhaust a single bucket for legitimate users,
	// and different attackers from different IPs get independent buckets.
	// Username is already bounded to 256 chars above; key size is therefore safe.
	const clientIp = getTrustedClientIp(c);
	const rlKey = `${clientIp}:${body.username}`;
	const retryAfterSecs = checkRateLimit(rlKey);
	if (retryAfterSecs !== null) {
		c.header("Retry-After", String(retryAfterSecs));
		return c.json({ error: "Too many failed attempts. Try again later." }, 429);
	}

	const user = await verifyCredentials(body.username, body.password);
	if (!user) {
		recordFailure(rlKey);
		return c.json({ error: "Invalid credentials" }, 401);
	}

	// Successful auth: clear the bucket so a legitimate user is never locked out.
	clearBucket(rlKey);

	const session = await issueSession({
		userId: user.id,
		userAgent: c.req.header("User-Agent") ?? null,
	});
	setCookie(c, SESSION_COOKIE_NAME, session.token, cookieOptions());
	return c.json({
		ok: true,
		user: { name: user.username, source: "local", id: user.id, role: user.role },
	});
});

authRouter.post("/auth/logout", async (c) => {
	const token = getCookie(c, SESSION_COOKIE_NAME);
	if (token) await revokeSessionByToken(token);
	deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
	return c.json({ ok: true });
});

/**
 * Signup is gated. Two paths are allowed:
 *   1. The install has zero users AND config.allowSignup=true — first-run
 *      admin creation (atomically gated by a sync transaction to prevent
 *      concurrent first-run races).
 *   2. The request is from an already-logged-in admin — seat management.
 * All other callers get 403.
 */
authRouter.post("/auth/signup", async (c) => {
	if (config.disableAuth) return c.json({ error: "Auth is disabled" }, 400);
	const body = await c.req.json<{ username?: string; password?: string }>();
	if (!body.username || !body.password) {
		return c.json({ error: "username and password required" }, 400);
	}

	// Password complexity (S-H1 / decision #4). Check before the DB round-trip
	// so the error is fast and the hash is never computed for weak passwords.
	const complexityError = checkPasswordComplexity(body.password);
	if (complexityError) {
		return c.json({ error: complexityError }, 400);
	}

	// Advisory pre-check outside the transaction (saves a hash on the obvious-deny path).
	const existingCount = await countActiveUsers();
	const caller = await getAuthUser(c);
	const isAdminCaller = caller?.source === "local" && caller.role === "admin";

	if (existingCount > 0 && !isAdminCaller) {
		return c.json({ error: "Signup is not enabled" }, 403);
	}
	if (!config.allowSignup && !isAdminCaller) {
		return c.json({ error: "Signup is not enabled" }, 403);
	}

	// Admin-caller path: no race condition possible (already authenticated).
	if (isAdminCaller) {
		try {
			const user = await createUser({
				username: body.username,
				password: body.password,
				role: "user",
			});
			return c.json({ ok: true, user }, 201);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	}

	// Hash outside the transaction — Bun.password.hash is CPU-intensive and
	// should not hold a DB transaction open while it runs.
	const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
	const userId = crypto.randomUUID();
	const now = new Date().toISOString();

	let raceWon = false;
	try {
		// withTransaction uses manual BEGIN/COMMIT/ROLLBACK on the SQLite path
		// so async callbacks are safe — COMMIT only fires after the Promise resolves.
		// On the Postgres path, db.transaction(fn) natively supports async callbacks.
		await withTransaction(async (tx) => {
			// Re-check: count ALL users (including soft-deleted) and the
			// firstRunCompleted flag inside the transaction so two concurrent
			// signups can't both pass. We intentionally count disabled users:
			// a soft-deleted bootstrap admin should NOT re-open the signup
			// window — the flag provides belt-and-suspenders, but the total
			// user count is the primary guard.
			const userRows = await tx.select({ id: users.id }).from(users);
			const totalCount = userRows.length;

			const flagRows = await tx
				.select({ value: settings.value })
				.from(settings)
				.where(eq(settings.key, "auth.firstRunCompleted"));
			const flagRow = flagRows[0];

			if (totalCount !== 0 || Boolean(flagRow?.value)) {
				// Race lost — another concurrent signup completed first, or the
				// instance already has users (even disabled ones). Return without
				// writing; the outer code returns 403.
				return;
			}

			// Both checks pass: create the admin user and set the flag atomically.
			await tx.insert(users).values({
				id: userId,
				username: body.username as string,
				passwordHash,
				role: "admin",
				createdAt: now,
				updatedAt: now,
			});

			await tx
				.insert(settings)
				.values({ key: "auth.firstRunCompleted", value: true, updatedAt: now })
				.onConflictDoUpdate({
					target: settings.key,
					set: { value: true, updatedAt: now },
				});

			raceWon = true;
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}

	if (!raceWon) {
		return c.json({ error: "Signup is not enabled" }, 403);
	}

	// Race won: issue a session so the new admin is logged in immediately.
	try {
		const session = await issueSession({
			userId,
			userAgent: c.req.header("User-Agent") ?? null,
		});
		setCookie(c, SESSION_COOKIE_NAME, session.token, cookieOptions());
	} catch {
		// Session issuance failure is non-fatal — the account was created.
		// The user can log in manually.
	}

	return c.json({ ok: true, user: { id: userId, username: body.username, role: "admin" } }, 201);
});

authRouter.post("/auth/change-password", requireAuth(), async (c) => {
	const user = await getAuthUser(c);
	if (!user || user.source !== "local" || !user.id) {
		return c.json({ error: "Only local accounts can change password here" }, 400);
	}
	const body = await c.req.json<{
		currentPassword?: string;
		newPassword?: string;
	}>();
	if (!body.currentPassword || !body.newPassword) {
		return c.json({ error: "currentPassword and newPassword required" }, 400);
	}
	// Enforce the same complexity policy as signup (S-H1 / decision #4).
	const complexityError = checkPasswordComplexity(body.newPassword);
	if (complexityError) {
		return c.json({ error: "password_complexity_failed", reason: complexityError }, 400);
	}
	try {
		const ok = await changeUserPassword({
			userId: user.id,
			currentPassword: body.currentPassword,
			newPassword: body.newPassword,
		});
		if (!ok) return c.json({ error: "Invalid current password" }, 401);
		// All sessions were revoked — issue a fresh one for this caller.
		const session = await issueSession({
			userId: user.id,
			userAgent: c.req.header("User-Agent") ?? null,
		});
		setCookie(c, SESSION_COOKIE_NAME, session.token, cookieOptions());
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

export { authRouter };
