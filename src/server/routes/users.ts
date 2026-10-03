import { Hono } from "hono";
import type { Context } from "hono";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import { getRequestActor, isHumanAdmin, requireOperatorScope } from "../auth/route-scope-policy.js";
import { logAdminAction } from "../services/audit-log.js";
import { validateUsername } from "../services/local-auth-service.js";
import {
	LastAdminError,
	NotLocalAccountError,
	RoleLockedByEnvError,
	UserNotFoundError,
	UsernameTakenError,
	createUserWithGeneratedPassword,
	disableUser,
	enableUser,
	listUserDirectory,
	listUsersForAdmin,
	resetUserPassword,
	setUserRole,
} from "../services/user-management.js";

const usersRouter = new Hono();
usersRouter.use("*", requireAuth());
// /users/directory is observe-readable; /users is manage-only; every mutation
// is a human-admin-only always-admin route, judged by the role policy too.
usersRouter.use("*", requireOperatorScope());

/**
 * Every mutation here needs a signed-in admin (or the DISABLE_AUTH operator),
 * never a key. The role policy enforces that before this router runs; the
 * services behind it ignore their actor, so the handlers hold the line too.
 */
function humanAdminOnly(c: Context): Response | null {
	const authUser = c.get("authUser") as AuthUser | undefined;
	if (authUser && isHumanAdmin(authUser)) return null;
	return c.json({ error: "human_admin_required" }, 403);
}

function parseRole(raw: unknown): "user" | "admin" | null {
	if (raw === "admin") return "admin";
	if (raw === "user" || raw === "member") return "user";
	return null;
}

function refuse(c: Context, err: unknown): Response {
	if (err instanceof UserNotFoundError) return c.json({ error: "user_not_found" }, 404);
	if (err instanceof LastAdminError) return c.json({ error: "last_admin" }, 409);
	if (err instanceof RoleLockedByEnvError) return c.json({ error: "role_locked_by_env" }, 409);
	if (err instanceof NotLocalAccountError) return c.json({ error: "not_local_account" }, 400);
	if (err instanceof UsernameTakenError) return c.json({ error: "username_taken" }, 409);
	throw err;
}

// GET /api/v1/users/directory - everyone who can own something, for pickers.
usersRouter.get("/users/directory", async (c) => {
	return c.json({ users: await listUserDirectory() });
});

// GET /api/v1/users - the admin list.
usersRouter.get("/users", async (c) => {
	return c.json({ users: await listUsersForAdmin() });
});

// POST /api/v1/users - create a local user with a generated one-time password.
usersRouter.post("/users", async (c) => {
	const denied = humanAdminOnly(c);
	if (denied) return denied;
	const body = (await c.req.json().catch(() => null)) as {
		username?: unknown;
		role?: unknown;
	} | null;
	const role = body?.role === undefined ? "user" : parseRole(body.role);
	if (typeof body?.username !== "string" || body.username === "" || role === null) {
		return c.json({ error: "invalid_user" }, 400);
	}
	try {
		validateUsername(body.username);
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : "invalid_username" }, 400);
	}

	try {
		const actor = await getRequestActor(c);
		const created = await createUserWithGeneratedPassword({ username: body.username, role }, actor);
		logAdminAction("user_created", actor, { userId: created.user.id, role });
		c.header("Cache-Control", "no-store");
		return c.json({ user: created.user, password: created.password }, 201);
	} catch (err) {
		return refuse(c, err);
	}
});

// PATCH /api/v1/users/:id - change a role.
usersRouter.patch("/users/:id", async (c) => {
	const denied = humanAdminOnly(c);
	if (denied) return denied;
	const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null;
	const role = parseRole(body?.role);
	if (role === null) return c.json({ error: "invalid_role" }, 400);
	const id = c.req.param("id");
	try {
		const actor = await getRequestActor(c);
		const { user } = await setUserRole(id, role, actor);
		logAdminAction("user_role_changed", actor, { userId: id, to: role });
		return c.json({ user });
	} catch (err) {
		return refuse(c, err);
	}
});

// POST /api/v1/users/:id/disable - { revokeHosts?: boolean } (default true).
usersRouter.post("/users/:id/disable", async (c) => {
	const denied = humanAdminOnly(c);
	if (denied) return denied;
	const body = (await c.req.json().catch(() => ({}))) as { revokeHosts?: unknown } | null;
	const revokeHosts = body?.revokeHosts;
	if (revokeHosts !== undefined && typeof revokeHosts !== "boolean") {
		return c.json({ error: "invalid_revoke_hosts" }, 400);
	}
	const id = c.req.param("id");
	try {
		const actor = await getRequestActor(c);
		await disableUser(id, { revokeHosts }, actor);
		logAdminAction("user_disabled", actor, { userId: id, revokeHosts: revokeHosts !== false });
		return c.json({ ok: true });
	} catch (err) {
		return refuse(c, err);
	}
});

// POST /api/v1/users/:id/enable - clears disabled_at only; restores nothing.
usersRouter.post("/users/:id/enable", async (c) => {
	const denied = humanAdminOnly(c);
	if (denied) return denied;
	const id = c.req.param("id");
	try {
		const actor = await getRequestActor(c);
		await enableUser(id, actor);
		logAdminAction("user_enabled", actor, { userId: id });
		return c.json({ ok: true });
	} catch (err) {
		return refuse(c, err);
	}
});

// POST /api/v1/users/:id/reset-password - a new generated password, once.
usersRouter.post("/users/:id/reset-password", async (c) => {
	const denied = humanAdminOnly(c);
	if (denied) return denied;
	const id = c.req.param("id");
	try {
		const actor = await getRequestActor(c);
		const { password } = await resetUserPassword(id, actor);
		logAdminAction("user_password_reset", actor, { userId: id });
		c.header("Cache-Control", "no-store");
		return c.json({ password });
	} catch (err) {
		return refuse(c, err);
	}
});

export { usersRouter };
