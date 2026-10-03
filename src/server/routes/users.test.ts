/**
 * /users: the directory every signed-in caller may read, the admin list, and
 * the human-admin mutations (create with a generated one-time password, role
 * change, disable, enable, reset password), plus the forced password change
 * that follows a create or a reset and the IDOR checks on the routes that sit
 * next to them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	UNTOUCHED_OWNED_RESOURCES,
	seedOwnedResources,
	snapshotOwnedResources,
} from "../test-utils/owned-resources.js";
import {
	TEST_PASSWORD,
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
	uniqueName,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { apiKeys, authSessions, sessions, supervisors, users } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { resolveSsoUser } = await import("../services/user-identity.js");
const { _setEnqueueHookProcessingOverrideForTest } = await import("./ingest.js");
const { verifyApiKey } = await import("../auth/api-key.js");

const originalDisableAuth = config.disableAuth;
const SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
const originalSubjects = process.env[SUBJECTS_ENV];

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalSubjects === undefined) delete process.env[SUBJECTS_ENV];
	else process.env[SUBJECTS_ENV] = originalSubjects;
	_setEnqueueHookProcessingOverrideForTest(null);
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function userRow(id: string) {
	const [row] = await getDb().select().from(users).where(eq(users.id, id));
	return row;
}

/** Every structured line logged during `fn`, parsed; nothing else. */
async function capturedLogs(
	fn: () => Promise<unknown>,
): Promise<{ lines: string[]; json: Array<Record<string, unknown>> }> {
	const lines: string[] = [];
	const record = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	const spies = [
		spyOn(console, "log").mockImplementation(record),
		spyOn(console, "info").mockImplementation(record),
		spyOn(console, "warn").mockImplementation(record),
		spyOn(console, "error").mockImplementation(record),
	];
	try {
		await fn();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	const json: Array<Record<string, unknown>> = [];
	for (const line of lines) {
		try {
			json.push(JSON.parse(line));
		} catch {
			// not a structured line
		}
	}
	return { lines, json };
}

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));

// ── The directory ─────────────────────────────────────────────────────────────

describe("GET /users/directory", () => {
	test("any signed-in caller, including a read-only key, gets id, displayName, disabled and where the name comes from, and nothing else", async () => {
		const member = await seedLocalUser("ud-member");
		const gone = await seedLocalUser("ud-gone");
		await disableUserDirectly(gone.id);
		const sso = await resolveSsoUser({
			provider: "authentik",
			subject: "ud-sso",
			source: "uid",
			username: "Sally Sso",
		});
		const observe = await seedKey("ud-observe", ["observe"]);

		for (const headers of [await cookieHeadersFor(member.id), bearerHeaders(observe.key)]) {
			const res = await app.request("/api/v1/users/directory", { headers });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { users: Array<Record<string, unknown>> };
			for (const row of body.users) {
				expect(Object.keys(row).sort()).toEqual(["authSource", "disabled", "displayName", "id"]);
			}
			const byId = new Map(body.users.map((row) => [row.id, row]));
			expect(byId.get(member.id)?.displayName).toBe(member.username);
			expect(byId.get(gone.id)?.disabled).toBe(true);
			expect(byId.get(sso.id)?.displayName).toBe("Sally Sso");
			expect(byId.get(member.id)?.authSource).toBe("local");
			expect(byId.get(sso.id)?.authSource).toBe("sso");
			expect(JSON.stringify(body)).not.toContain("sso:authentik");
		}
	});

	test("an unauthenticated request is 401", async () => {
		expect((await app.request("/api/v1/users/directory")).status).toBe(401);
	});
});

// ── The admin list ────────────────────────────────────────────────────────────

describe("GET /users", () => {
	test("an admin gets role, source, last login, counts, the env lock and the subject source for every row", async () => {
		const admin = await seedLocalUser("ul-admin", "admin");
		const member = await seedLocalUser("ul-member");
		await seedKey("ul-key-1", ["manage"], member.id);
		await seedKey("ul-key-2", ["ingest"], member.id);
		const revoked = await seedKey("ul-key-3", ["ingest"], member.id);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, revoked.id));
		const hostId = crypto.randomUUID();
		await getDb().insert(supervisors).values({
			id: hostId,
			hostName: "ul-host",
			platform: "linux",
			arch: "x64",
			version: "0",
			ownerUserId: member.id,
		});
		// A revoked host doesn't count towards the member's hosts.
		await getDb().insert(supervisors).values({
			id: crypto.randomUUID(),
			hostName: "ul-revoked-host",
			platform: "linux",
			arch: "x64",
			version: "0",
			ownerUserId: member.id,
			enrollmentState: "revoked",
		});

		const uidUser = await resolveSsoUser({
			provider: "authentik",
			subject: "ul-uid",
			source: "uid",
			username: "Uid User",
		});
		const nameUser = await resolveSsoUser({
			provider: "authentik",
			subject: "ul-name",
			source: "username",
			username: "Name User",
		});
		const nullUser = await resolveSsoUser({
			provider: "authentik",
			subject: "ul-null",
			source: null,
			username: "Null User",
		});
		await getDb().update(users).set({ role: "admin" }).where(eq(users.id, uidUser.id));
		process.env[SUBJECTS_ENV] = "ul-uid";

		const res = await app.request("/api/v1/users", { headers: await cookieHeadersFor(admin.id) });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain("passwordHash");
		expect(text).not.toContain("password_hash");
		const body = JSON.parse(text) as { users: Array<Record<string, unknown>> };
		const byId = new Map(body.users.map((row) => [row.id as string, row]));

		const memberRow = byId.get(member.id);
		expect(memberRow?.role).toBe("user");
		expect(memberRow?.authSource).toBe("local");
		expect(memberRow?.keyCount).toBe(2);
		expect(memberRow?.hostCount).toBe(1);
		expect(memberRow?.disabled).toBe(false);
		expect(memberRow?.mustChangePassword).toBe(false);
		expect(byId.get(admin.id)?.role).toBe("admin");

		expect(byId.get(uidUser.id)?.subjectSource).toBe("uid");
		expect(byId.get(uidUser.id)?.roleLockedByEnv).toBe(true);
		expect(byId.get(uidUser.id)?.provider).toBe("authentik");
		expect(byId.get(nameUser.id)?.subjectSource).toBe("username");
		expect(byId.get(nullUser.id)?.subjectSource).toBeNull();
		expect(byId.get(nullUser.id)?.roleLockedByEnv).toBe(false);
	});

	test("is for admins in both modes: a member is refused, a read-only key is out of scope", async () => {
		const member = await seedLocalUser("ul-refused");
		const observe = await seedKey("ul-observe", ["observe"]);
		for (const mode of ["solo", "team"] as const) {
			if (mode === "team") await setStoredMode("team");
			const asMember = await app.request("/api/v1/users", {
				headers: await cookieHeadersFor(member.id),
			});
			expect(asMember.status).toBe(403);
			expect(((await asMember.json()) as { error: string }).error).toBe("admin_required");
		}
		const asObserve = await app.request("/api/v1/users", { headers: bearerHeaders(observe.key) });
		expect(asObserve.status).toBe(403);
	});

	test("an admin-owned manage key may read it (admin, not human-only)", async () => {
		const admin = await seedLocalUser("ul-key-admin", "admin");
		const { key } = await seedKey("ul-key", ["manage"], admin.id);
		const res = await app.request("/api/v1/users", { headers: bearerHeaders(key) });
		expect(res.status).toBe(200);
	});
});

// ── Create ────────────────────────────────────────────────────────────────────

describe("POST /users", () => {
	test("creates a local user with a generated password, returned once and never logged, flagged to be changed", async () => {
		const admin = await seedLocalUser("uc-admin", "admin");
		const username = uniqueName("uc-new");
		let res: Response | null = null;
		const logs = await capturedLogs(async () => {
			res = await call("/users", "POST", { username }, await cookieHeadersFor(admin.id));
		});
		if (!res) throw new Error("no response");
		expect((res as Response).status).toBe(201);
		expect((res as Response).headers.get("cache-control")).toBe("no-store");
		const body = (await (res as Response).json()) as {
			user: { id: string; username: string; role: string };
			password: string;
		};
		expect(body.user.username).toBe(username);
		expect(body.user.role).toBe("user");
		expect(body.password.length).toBeGreaterThanOrEqual(24);

		const row = await userRow(body.user.id);
		expect(row?.mustChangePassword).toBe(true);
		expect(row?.authSource).toBe("local");
		expect(logs.lines.join("\n")).not.toContain(body.password);
		const audit = logs.json.find((line) => line.kind === "user_created");
		expect(audit?.by).toBe(admin.id);
		expect(audit?.userId).toBe(body.user.id);
	});

	test("the new user signs in with it, is held to /auth/me and the change until they change it, then everything opens", async () => {
		const admin = await seedLocalUser("uc-flow-admin", "admin");
		const username = uniqueName("uc-flow");
		const created = await call(
			"/users",
			"POST",
			{ username, role: "user" },
			await cookieHeadersFor(admin.id),
		);
		expect(created.status).toBe(201);
		const { password } = (await created.json()) as { password: string };

		const login = await call("/auth/login", "POST", { username, password }, new Headers());
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
		const headers = () => new Headers({ Cookie: cookie });

		const blocked = await app.request("/api/v1/sessions/stats", { headers: headers() });
		expect(blocked.status).toBe(403);
		expect(await blocked.json()).toEqual({ error: "password_change_required" });
		const me = await app.request("/api/v1/auth/me", { headers: headers() });
		expect(
			((await me.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword,
		).toBe(true);

		const change = await call(
			"/auth/change-password",
			"POST",
			{ currentPassword: password, newPassword: "A-brand-new-Pass-77!" },
			headers(),
		);
		expect(change.status).toBe(200);
		const fresh = new Headers({ Cookie: (change.headers.get("set-cookie") ?? "").split(";")[0] });
		expect((await app.request("/api/v1/sessions/stats", { headers: fresh })).status).toBe(200);
	});

	test("an admin role can be given at creation; a bad role, a bad username or a taken one is refused", async () => {
		const admin = await seedLocalUser("uc-roles", "admin");
		const headers = await cookieHeadersFor(admin.id);
		const adminCreated = await call(
			"/users",
			"POST",
			{ username: uniqueName("uc-admin2"), role: "admin" },
			headers,
		);
		expect(adminCreated.status).toBe(201);
		expect(((await adminCreated.json()) as { user: { role: string } }).user.role).toBe("admin");

		expect(
			(
				await call(
					"/users",
					"POST",
					{ username: uniqueName("uc-bad-role"), role: "owner" },
					headers,
				)
			).status,
		).toBe(400);
		expect((await call("/users", "POST", { username: "sso:authentik:x" }, headers)).status).toBe(
			400,
		);
		expect((await call("/users", "POST", {}, headers)).status).toBe(400);

		const taken = uniqueName("uc-taken");
		expect((await call("/users", "POST", { username: taken }, headers)).status).toBe(201);
		const again = await call("/users", "POST", { username: taken }, headers);
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: string }).error).toBe("username_taken");
	});

	test("a member and every key are refused; DISABLE_AUTH's operator may", async () => {
		const admin = await seedLocalUser("uc-who-admin", "admin");
		const member = await seedLocalUser("uc-who-member");
		const adminKey = await seedKey("uc-who-key", ["manage"], admin.id);
		const service = await seedKey("uc-who-service", ["manage"]);

		const asMember = await call(
			"/users",
			"POST",
			{ username: uniqueName("uc-x") },
			await cookieHeadersFor(member.id),
		);
		expect(asMember.status).toBe(403);
		for (const headers of [bearerHeaders(adminKey.key), bearerHeaders(service.key)]) {
			const res = await call("/users", "POST", { username: uniqueName("uc-y") }, headers);
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toBe("human_admin_required");
		}

		(config as Record<string, unknown>).disableAuth = true;
		const operator = await call(
			"/users",
			"POST",
			{ username: uniqueName("uc-operator") },
			new Headers(),
		);
		expect(operator.status).toBe(201);
	});
});

// ── Role ──────────────────────────────────────────────────────────────────────

describe("PATCH /users/:id", () => {
	test("a human admin changes a role and the change is logged against them", async () => {
		const admin = await seedLocalUser("ur-admin", "admin");
		const target = await seedLocalUser("ur-target");
		let res: Response | null = null;
		const logs = await capturedLogs(async () => {
			res = await call(
				`/users/${target.id}`,
				"PATCH",
				{ role: "admin" },
				await cookieHeadersFor(admin.id),
			);
		});
		expect((res as unknown as Response).status).toBe(200);
		expect((await userRow(target.id))?.role).toBe("admin");
		const audit = logs.json.find((line) => line.kind === "user_role_changed");
		expect(audit?.by).toBe(admin.id);
		expect(audit?.userId).toBe(target.id);
		expect(audit?.to).toBe("admin");

		const back = await call(
			`/users/${target.id}`,
			"PATCH",
			{ role: "member" },
			await cookieHeadersFor(admin.id),
		);
		expect(back.status).toBe(200);
		expect((await userRow(target.id))?.role).toBe("user");
	});

	test("the last active admin can't be demoted", async () => {
		const only = await seedLocalUser("ur-only", "admin");
		const res = await call(
			`/users/${only.id}`,
			"PATCH",
			{ role: "user" },
			await cookieHeadersFor(only.id),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("last_admin");
		expect((await userRow(only.id))?.role).toBe("admin");
	});

	test("an admin listed by the env can't be demoted in the UI", async () => {
		const admin = await seedLocalUser("ur-env-admin", "admin");
		const sso = await resolveSsoUser({
			provider: "authentik",
			subject: "ur-listed",
			source: "uid",
			username: "Listed",
		});
		await getDb().update(users).set({ role: "admin" }).where(eq(users.id, sso.id));
		process.env[SUBJECTS_ENV] = "ur-listed";
		const res = await call(
			`/users/${sso.id}`,
			"PATCH",
			{ role: "user" },
			await cookieHeadersFor(admin.id),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("role_locked_by_env");
		expect((await userRow(sso.id))?.role).toBe("admin");
	});

	test("an unknown user is 404 and a bad role 400; a member is refused and writes nothing", async () => {
		const admin = await seedLocalUser("ur-misc-admin", "admin");
		const member = await seedLocalUser("ur-misc-member");
		const other = await seedLocalUser("ur-misc-other");
		const headers = await cookieHeadersFor(admin.id);
		expect((await call("/users/nope", "PATCH", { role: "admin" }, headers)).status).toBe(404);
		expect((await call(`/users/${other.id}`, "PATCH", { role: "root" }, headers)).status).toBe(400);
		const asMember = await call(
			`/users/${other.id}`,
			"PATCH",
			{ role: "admin" },
			await cookieHeadersFor(member.id),
		);
		expect(asMember.status).toBe(403);
		expect((await userRow(other.id))?.role).toBe("user");
	});
});

// ── Disable and enable ────────────────────────────────────────────────────────

describe("POST /users/:id/disable and /enable", () => {
	test("disabling kills the cookie on the next request, switches off keys and revokes hosts; sessions are untouched", async () => {
		const admin = await seedLocalUser("ud-admin", "admin");
		const target = await seedLocalUser("ud-target");
		const owned = await seedOwnedResources(target.id);
		const targetHeaders = await cookieHeadersFor(target.id);
		expect((await app.request("/api/v1/sessions/stats", { headers: targetHeaders })).status).toBe(
			200,
		);

		let res: Response | null = null;
		const logs = await capturedLogs(async () => {
			res = await call(`/users/${target.id}/disable`, "POST", {}, await cookieHeadersFor(admin.id));
		});
		expect((res as unknown as Response).status).toBe(200);
		expect(logs.json.find((line) => line.kind === "user_disabled")?.by).toBe(admin.id);

		expect((await app.request("/api/v1/sessions/stats", { headers: targetHeaders })).status).toBe(
			401,
		);
		const snapshot = await snapshotOwnedResources(owned);
		expect(snapshot.keyActive).toBe(false);
		expect(snapshot.hostState).toBe("revoked");
		expect(snapshot.credentialActive).toBe(false);
		expect(snapshot.sessionRowOwner).toBe(target.id);
		expect(snapshot.disabledAt).not.toBeNull();
	});

	test("with revokeHosts: false the host stays enrolled", async () => {
		const admin = await seedLocalUser("ud-keep-admin", "admin");
		const target = await seedLocalUser("ud-keep-target");
		const owned = await seedOwnedResources(target.id);
		const res = await call(
			`/users/${target.id}/disable`,
			"POST",
			{ revokeHosts: false },
			await cookieHeadersFor(admin.id),
		);
		expect(res.status).toBe(200);
		const snapshot = await snapshotOwnedResources(owned);
		expect(snapshot.keyActive).toBe(false);
		expect(snapshot.hostState).toBe("active");
		expect(snapshot.credentialActive).toBe(true);
	});

	test("the last active admin can't be disabled; a non-boolean revokeHosts is a 400; an unknown user a 404", async () => {
		const only = await seedLocalUser("ud-only", "admin");
		const headers = await cookieHeadersFor(only.id);
		const last = await call(`/users/${only.id}/disable`, "POST", {}, headers);
		expect(last.status).toBe(409);
		expect(((await last.json()) as { error: string }).error).toBe("last_admin");
		expect((await userRow(only.id))?.disabledAt).toBeNull();
		expect(
			(await call(`/users/${only.id}/disable`, "POST", { revokeHosts: "yes" }, headers)).status,
		).toBe(400);
		expect((await call("/users/nope/disable", "POST", {}, headers)).status).toBe(404);
	});

	test("enabling clears disabled_at and restores nothing", async () => {
		const admin = await seedLocalUser("ue-admin", "admin");
		const target = await seedLocalUser("ue-target");
		const owned = await seedOwnedResources(target.id);
		const headers = await cookieHeadersFor(admin.id);
		await call(`/users/${target.id}/disable`, "POST", {}, headers);

		let res: Response | null = null;
		const logs = await capturedLogs(async () => {
			res = await call(`/users/${target.id}/enable`, "POST", {}, headers);
		});
		expect((res as unknown as Response).status).toBe(200);
		expect(logs.json.find((line) => line.kind === "user_enabled")?.by).toBe(admin.id);
		const snapshot = await snapshotOwnedResources(owned);
		expect(snapshot.disabledAt).toBeNull();
		expect(snapshot.keyActive).toBe(false);
		expect(snapshot.hostState).toBe("revoked");
		expect((await call("/users/nope/enable", "POST", {}, headers)).status).toBe(404);
	});

	test("a member and a key are refused and nothing changes", async () => {
		const admin = await seedLocalUser("ud-refuse-admin", "admin");
		const member = await seedLocalUser("ud-refuse-member");
		const target = await seedLocalUser("ud-refuse-target");
		const owned = await seedOwnedResources(target.id);
		const adminKey = await seedKey("ud-refuse-key", ["manage"], admin.id);
		const asMember = await call(
			`/users/${target.id}/disable`,
			"POST",
			{},
			await cookieHeadersFor(member.id),
		);
		expect(asMember.status).toBe(403);
		const asKey = await call(
			`/users/${target.id}/disable`,
			"POST",
			{},
			bearerHeaders(adminKey.key),
		);
		expect(asKey.status).toBe(403);
		expect(await snapshotOwnedResources(owned)).toEqual(UNTOUCHED_OWNED_RESOURCES(target.id));
	});
});

// ── Reset password ────────────────────────────────────────────────────────────

describe("POST /users/:id/reset-password", () => {
	test("returns a new password once; the old one stops working, their sessions go, the flag is set, nothing is logged", async () => {
		const admin = await seedLocalUser("up-admin", "admin");
		const target = await seedLocalUser("up-target");
		const targetHeaders = await cookieHeadersFor(target.id);
		let res: Response | null = null;
		const logs = await capturedLogs(async () => {
			res = await call(
				`/users/${target.id}/reset-password`,
				"POST",
				{},
				await cookieHeadersFor(admin.id),
			);
		});
		expect((res as unknown as Response).status).toBe(200);
		expect((res as unknown as Response).headers.get("cache-control")).toBe("no-store");
		const { password } = (await (res as unknown as Response).json()) as { password: string };
		expect(password.length).toBeGreaterThanOrEqual(24);
		expect(logs.lines.join("\n")).not.toContain(password);
		expect(logs.json.find((line) => line.kind === "user_password_reset")?.by).toBe(admin.id);

		const oldLogin = await call(
			"/auth/login",
			"POST",
			{ username: target.username, password: TEST_PASSWORD },
			new Headers(),
		);
		expect(oldLogin.status).toBe(401);
		const newLogin = await call(
			"/auth/login",
			"POST",
			{ username: target.username, password },
			new Headers(),
		);
		expect(newLogin.status).toBe(200);
		expect((await app.request("/api/v1/sessions/stats", { headers: targetHeaders })).status).toBe(
			401,
		);
		expect((await userRow(target.id))?.mustChangePassword).toBe(true);
		const remaining = await getDb()
			.select()
			.from(authSessions)
			.where(eq(authSessions.userId, target.id));
		expect(remaining.length).toBe(1); // only the login above
	});

	test("after a reset the user's existing manage key is gated on the dashboard routes while their hooks still land", async () => {
		const admin = await seedLocalUser("up-key-admin", "admin");
		const target = await seedLocalUser("up-key-target");
		const { key } = await seedKey("up-key", ["ingest", "manage"], target.id);
		expect((await app.request("/api/v1/sessions", { headers: bearerHeaders(key) })).status).toBe(
			200,
		);

		await call(`/users/${target.id}/reset-password`, "POST", {}, await cookieHeadersFor(admin.id));

		const read = await app.request("/api/v1/sessions", { headers: bearerHeaders(key) });
		expect(read.status).toBe(403);
		expect(await read.json()).toEqual({ error: "password_change_required" });
		const enqueued: string[] = [];
		_setEnqueueHookProcessingOverrideForTest(async (payload) => {
			enqueued.push(payload.session_id);
		});
		const hook = await call(
			"/hooks",
			"POST",
			{ session_id: "up-key-hook", hook_event_name: "SessionStart" },
			bearerHeaders(key),
		);
		expect(hook.status).toBe(200);
		expect(enqueued).toEqual(["up-key-hook"]);
	});

	test("an SSO user has no password to reset (400), an unknown user is 404, a member is refused", async () => {
		const admin = await seedLocalUser("up-misc-admin", "admin");
		const member = await seedLocalUser("up-misc-member");
		const sso = await resolveSsoUser({
			provider: "authentik",
			subject: "up-sso",
			source: "uid",
			username: "Sso",
		});
		const headers = await cookieHeadersFor(admin.id);
		const ssoRes = await call(`/users/${sso.id}/reset-password`, "POST", {}, headers);
		expect(ssoRes.status).toBe(400);
		expect(((await ssoRes.json()) as { error: string }).error).toBe("not_local_account");
		expect((await call("/users/nope/reset-password", "POST", {}, headers)).status).toBe(404);
		expect(
			(
				await call(
					`/users/${admin.id}/reset-password`,
					"POST",
					{},
					await cookieHeadersFor(member.id),
				)
			).status,
		).toBe(403);
	});
});

// ── IDOR ──────────────────────────────────────────────────────────────────────

describe("a member can't reach what isn't theirs", () => {
	test("PATCH /users/:other, PATCH /sessions/:id/owner and PATCH /admin/supervisors/:id are 403, DELETE /api-keys/:other's is a 404, and none writes anything", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("idor-admin", "admin");
		const member = await seedLocalUser("idor-member");
		const other = await seedLocalUser("idor-other");
		const otherKey = await seedKey("idor-key", ["manage"], other.id);
		const hostId = crypto.randomUUID();
		await getDb().insert(supervisors).values({
			id: hostId,
			hostName: "idor-host",
			platform: "linux",
			arch: "x64",
			version: "0",
			ownerUserId: other.id,
		});
		await getDb()
			.insert(sessions)
			.values({ sessionId: "idor-session", agentType: "claude_code", ownerUserId: other.id });
		const headers = await cookieHeadersFor(member.id);

		const roleRes = await call(`/users/${other.id}`, "PATCH", { role: "admin" }, headers);
		expect(roleRes.status).toBe(403);
		expect((await userRow(other.id))?.role).toBe("user");

		const keyRes = await app.request(`/api/v1/api-keys/${otherKey.id}`, {
			method: "DELETE",
			headers,
		});
		// "Not yours" answers exactly as "doesn't exist".
		expect(keyRes.status).toBe(404);
		const [keyRow] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, otherKey.id));
		expect(keyRow?.isActive).toBe(true);

		const ownerRes = await call(
			"/sessions/idor-session/owner",
			"PATCH",
			{ ownerUserId: member.id },
			headers,
		);
		expect(ownerRes.status).toBe(403);
		const [sessionRow] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, "idor-session"));
		expect(sessionRow?.ownerUserId).toBe(other.id);

		const hostRes = await call(
			`/admin/supervisors/${hostId}`,
			"PATCH",
			{ ownerUserId: member.id },
			headers,
		);
		expect(hostRes.status).toBe(403);
		const [hostRow] = await getDb().select().from(supervisors).where(eq(supervisors.id, hostId));
		expect(hostRow?.ownerUserId).toBe(other.id);
		expect(admin.id).not.toBe(member.id);
	});
});

describe("a disabled user's key is dead even before anyone switches it off", () => {
	test("verifyApiKey refuses it", async () => {
		const target = await seedLocalUser("dk-target");
		const { key } = await seedKey("dk-key", ["manage"], target.id);
		expect(await verifyApiKey(key)).not.toBeNull();
		await disableUserDirectly(target.id);
		expect(await verifyApiKey(key)).toBeNull();
	});
});

describe("the users router holds the human-admin line itself, even where no policy is mounted in front of it", () => {
	test("a member and every key are refused on each mutation; an admin gets through", async () => {
		const { Hono } = await import("hono");
		const { usersRouter } = await import("./users.js");
		const bare = new Hono();
		bare.route("/api/v1", usersRouter);

		const admin = await seedLocalUser("hl-admin", "admin");
		const member = await seedLocalUser("hl-member");
		const adminKey = await seedKey("hl-admin-key", ["manage"], admin.id);
		const service = await seedKey("hl-service", ["manage"]);
		const target = await seedLocalUser("hl-target");

		const mutations: Array<[string, string, unknown]> = [
			["POST", "/api/v1/users", { username: uniqueName("hl-new") }],
			["PATCH", `/api/v1/users/${target.id}`, { role: "admin" }],
			["POST", `/api/v1/users/${target.id}/disable`, {}],
			["POST", `/api/v1/users/${target.id}/enable`, {}],
			["POST", `/api/v1/users/${target.id}/reset-password`, {}],
		];
		for (const [method, path, body] of mutations) {
			for (const headers of [
				await cookieHeadersFor(member.id),
				bearerHeaders(adminKey.key),
				bearerHeaders(service.key),
			]) {
				const res = await bare.request(path, jsonRequest(method, body, headers));
				expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
			}
		}
		const allowed = await bare.request(
			"/api/v1/users",
			jsonRequest("POST", { username: uniqueName("hl-ok") }, await cookieHeadersFor(admin.id)),
		);
		expect(allowed.status).toBe(201);
		expect((await userRow(target.id))?.role).toBe("user");
	});
});
