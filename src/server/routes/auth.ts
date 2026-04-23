import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
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
 *      admin creation.
 *   2. The request is from an already-logged-in admin — seat management.
 * All other callers get 403.
 */
authRouter.post("/auth/signup", async (c) => {
	if (config.disableAuth) return c.json({ error: "Auth is disabled" }, 400);
	const body = await c.req.json<{ username?: string; password?: string }>();
	if (!body.username || !body.password) {
		return c.json({ error: "username and password required" }, 400);
	}
	const existingCount = await countActiveUsers();
	const caller = await getAuthUser(c);
	const isFirstRun = existingCount === 0 && config.allowSignup;
	const isAdminCaller = caller?.source === "local" && caller.role === "admin";
	if (!isFirstRun && !isAdminCaller) {
		return c.json({ error: "Signup is not enabled" }, 403);
	}
	try {
		const user = await createUser({
			username: body.username,
			password: body.password,
			role: isFirstRun ? "admin" : "user",
		});
		if (isFirstRun) {
			// Drop the caller straight into a session so they don't have
			// to log in right after creating their own admin account.
			const session = await issueSession({
				userId: user.id,
				userAgent: c.req.header("User-Agent") ?? null,
			});
			setCookie(c, SESSION_COOKIE_NAME, session.token, cookieOptions());
		}
		return c.json({ ok: true, user }, 201);
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
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
