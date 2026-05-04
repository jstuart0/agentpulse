import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { settings, users } from "../db/schema.js";
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

/**
 * Introspection + local-account auth routes. Local accounts coexist
 * with Authentik forwardauth and API-key bearer flows; the priority
 * order lives in `auth/middleware.ts`. When DISABLE_AUTH=true all
 * endpoints here are effectively no-ops because the middleware stamps
 * every request as anonymous upstream.
 */
const authRouter = new Hono();

function cookieOptions() {
	return {
		path: "/",
		httpOnly: true,
		secure: config.isProduction,
		sameSite: "Lax" as const,
		maxAge: Math.floor(SESSION_DURATION_MS / 1000),
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
	const signOutUrl =
		user.source === "authentik"
			? "/outpost.goauthentik.io/sign_out"
			: user.source === "local"
				? "/api/v1/auth/logout"
				: null;
	return c.json({
		authenticated: true,
		user: {
			name: user.name,
			source: user.source,
			id: user.id ?? null,
			role: user.role ?? null,
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
	const user = await verifyCredentials(body.username, body.password);
	if (!user) return c.json({ error: "Invalid credentials" }, 401);
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

	// First-run path: hash OUTSIDE the transaction (Bun.password.hash is async;
	// bun-sqlite Drizzle sync transactions must not await inside the callback).
	// Do NOT make the db.transaction callback async — bun-sqlite Drizzle async-tx
	// callbacks commit before awaited work settles. Hash outside the tx; only
	// sync ops inside.
	// See: src/server/routes/sessions.ts:281-284 for the canonical warning.
	const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
	const userId = crypto.randomUUID();
	const now = new Date().toISOString();

	let raceWon = false;
	try {
		// SYNCHRONOUS callback only — bun-sqlite Drizzle commits before awaited
		// work in async callbacks; see src/server/routes/sessions.ts:281-284.
		db.transaction((tx) => {
			// Re-check: count ALL users (including soft-deleted) and the
			// firstRunCompleted flag inside the transaction so two concurrent
			// signups can't both pass. We intentionally count disabled users:
			// a soft-deleted bootstrap admin should NOT re-open the signup
			// window — the flag provides belt-and-suspenders, but the total
			// user count is the primary guard.
			const totalCount = tx.select({ id: users.id }).from(users).all().length;

			const flagRow = tx
				.select({ value: settings.value })
				.from(settings)
				.where(eq(settings.key, "auth.firstRunCompleted"))
				.get();

			if (totalCount !== 0 || flagRow?.value === "true") {
				// Race lost — another concurrent signup completed first, or the
				// instance already has users (even disabled ones). Return without
				// writing; the outer code returns 403.
				return;
			}

			// Both checks pass: create the admin user and set the flag atomically.
			tx.insert(users)
				.values({
					id: userId,
					username: body.username as string,
					passwordHash,
					role: "admin",
					createdAt: now,
					updatedAt: now,
				})
				.run();

			tx.insert(settings)
				.values({ key: "auth.firstRunCompleted", value: "true", updatedAt: now })
				.onConflictDoUpdate({
					target: settings.key,
					set: { value: "true", updatedAt: now },
				})
				.run();

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
