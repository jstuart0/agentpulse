/**
 * The role policy: who counts as an admin for the always-admin routes (both
 * modes) and the team-admin routes (team mode only), for every kind of caller.
 *
 * Callers: a local admin and a local member (cookie), an API key owned by an
 * admin, an API key owned by a member, an ownerless manage key (a service key,
 * listed or not), a host credential, and the DISABLE_AUTH operator. The policy
 * is exercised on a small app that registers every route in both sets, so each
 * entry is judged on its own; the real app's registration of those routes is
 * pinned by the route tests that follow them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono as HonoApp } from "hono";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
	setUserRoleDirectly,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { supervisors } = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { getAuthUserFromHeaders, requireSupervisorAuth } = await import("./middleware.js");
type AuthUser = NonNullable<Awaited<ReturnType<typeof getAuthUserFromHeaders>>>;
const {
	ALWAYS_ADMIN_ROUTES,
	OWNER_CHECKED_ROUTES,
	TEAM_ADMIN_ROUTES,
	requireRolePolicy,
	resolveEffectiveRole,
} = await import("./route-scope-policy.js");
const { createSupervisorCredential } = await import("./supervisor-auth.js");

const originalDisableAuth = config.disableAuth;
const MODE_ENV = "AGENTPULSE_MODE";
const originalModeEnv = process.env[MODE_ENV];

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalModeEnv === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = originalModeEnv;
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

function concrete(template: string): string {
	return template.replace(/:[A-Za-z]+/g, "abc");
}

function splitEntry(entry: string): { method: string; template: string } {
	const [method, template] = entry.split(" ");
	return { method, template };
}

function policyApp() {
	const app = new Hono();
	app.use("*", requireRolePolicy());
	for (const entry of [...ALWAYS_ADMIN_ROUTES.keys(), ...TEAM_ADMIN_ROUTES]) {
		const { method, template } = splitEntry(entry);
		app.on(method, template, (c) => c.json({ reached: true }));
	}
	return app;
}

interface Callers {
	adminCookie: Headers;
	memberCookie: Headers;
	adminKey: Headers;
	memberKey: Headers;
	ownerlessManage: Headers;
	ownerlessManageId: string;
	ownerlessObserve: Headers;
}

async function seedCallers(): Promise<Callers> {
	const admin = await seedLocalUser("rp-admin", "admin");
	const member = await seedLocalUser("rp-member", "user");
	const adminKey = await seedKey("rp-admin-key", ["manage"], admin.id);
	const memberKey = await seedKey("rp-member-key", ["manage"], member.id);
	const service = await seedKey("rp-service", ["manage"]);
	const observe = await seedKey("rp-observe", ["observe"]);
	return {
		adminCookie: await cookieHeadersFor(admin.id),
		memberCookie: await cookieHeadersFor(member.id),
		adminKey: bearerHeaders(adminKey.key),
		memberKey: bearerHeaders(memberKey.key),
		ownerlessManage: bearerHeaders(service.key),
		ownerlessManageId: service.id,
		ownerlessObserve: bearerHeaders(observe.key),
	};
}

async function call(app: HonoApp, entry: string, headers: Headers) {
	const { method, template } = splitEntry(entry);
	const res = await app.request(concrete(template), { method, headers });
	const body = (await res.json().catch(() => ({}))) as { error?: string; reached?: boolean };
	return { status: res.status, error: body.error, reached: body.reached === true };
}

const OPEN = { status: 200, error: undefined, reached: true };
const adminRequired = { status: 403, error: "admin_required", reached: false };
const humanAdminRequired = { status: 403, error: "human_admin_required", reached: false };

describe("the route sets", () => {
	test("have exactly the pinned sizes", () => {
		expect(ALWAYS_ADMIN_ROUTES.size).toBe(11);
		expect(TEAM_ADMIN_ROUTES.size).toBe(20);
	});

	test("every mutating channel route is admin-only in team mode, by name", () => {
		for (const named of [
			"POST /channels",
			"DELETE /channels/:id",
			"PATCH /channels/:id/config",
			"POST /channels/:id/test",
		]) {
			expect({ named, listed: TEAM_ADMIN_ROUTES.has(named) }).toEqual({ named, listed: true });
		}
	});

	test("no route is in both sets, and the human-only entries are exactly the user, mode and claim mutations", () => {
		for (const entry of TEAM_ADMIN_ROUTES) expect(ALWAYS_ADMIN_ROUTES.has(entry)).toBe(false);
		const humanOnly = [...ALWAYS_ADMIN_ROUTES].filter(([, v]) => v.humanOnly).map(([k]) => k);
		expect(humanOnly.sort()).toEqual(
			[
				"POST /users",
				"PATCH /users/:id",
				"POST /users/:id/disable",
				"POST /users/:id/enable",
				"POST /users/:id/reset-password",
				"PUT /instance/mode",
				"POST /instance/claim-unassigned",
			].sort(),
		);
	});
});

describe("the route sets match the real app", () => {
	test("every entry of both sets is a registered route, under both mounts", async () => {
		const { app } = await import("../app.js");
		const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
		expect(app.routes.length).toBeGreaterThan(200);
		for (const entry of [...ALWAYS_ADMIN_ROUTES.keys(), ...TEAM_ADMIN_ROUTES]) {
			const [method, template] = entry.split(" ");
			for (const mount of ["/api/v1", "/app-api/v1"]) {
				expect({
					entry,
					mount,
					registered: registered.has(`${method} ${mount}${template}`),
				}).toEqual({
					entry,
					mount,
					registered: true,
				});
			}
		}
	});
});

describe("routes judged inside the handler (owner-or-admin, through the authorization service)", () => {
	test("are listed, pinned in size, registered on the real app, and in neither policy set", async () => {
		const { app } = await import("../app.js");
		expect(OWNER_CHECKED_ROUTES.size).toBe(16);
		const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
		for (const entry of OWNER_CHECKED_ROUTES) {
			const [method, template] = entry.split(" ");
			expect({ entry, registered: registered.has(`${method} /api/v1${template}`) }).toEqual({
				entry,
				registered: true,
			});
			expect(ALWAYS_ADMIN_ROUTES.has(entry)).toBe(false);
			expect(TEAM_ADMIN_ROUTES.has(entry)).toBe(false);
		}
		for (const named of [
			"POST /sessions/:sessionId/acknowledge",
			"DELETE /sessions/:sessionId/acknowledge",
		]) {
			expect(OWNER_CHECKED_ROUTES.has(named)).toBe(true);
		}
	});
});

describe("resolveEffectiveRole", () => {
	async function roleOf(headers: Headers, mode: "solo" | "team") {
		const authUser = await getAuthUserFromHeaders(headers);
		if (!authUser) throw new Error("caller did not resolve");
		return resolveEffectiveRole(authUser, mode);
	}

	test("a cookie user is their current role", async () => {
		const c = await seedCallers();
		expect(await roleOf(c.adminCookie, "solo")).toBe("admin");
		expect(await roleOf(c.adminCookie, "team")).toBe("admin");
		expect(await roleOf(c.memberCookie, "solo")).toBe("member");
		expect(await roleOf(c.memberCookie, "team")).toBe("member");
	});

	test("a key owned by a user is that user's role, in both modes", async () => {
		const c = await seedCallers();
		for (const mode of ["solo", "team"] as const) {
			expect(await roleOf(c.adminKey, mode)).toBe("admin");
			expect(await roleOf(c.memberKey, mode)).toBe("member");
		}
	});

	test("an ownerless manage key is an admin in solo, and in team only when kept", async () => {
		const c = await seedCallers();
		expect(await roleOf(c.ownerlessManage, "solo")).toBe("admin");
		expect(await roleOf(c.ownerlessManage, "team")).toBe("member");
		await setAdminServiceKeyList([c.ownerlessManageId]);
		expect(await roleOf(c.ownerlessManage, "team")).toBe("admin");
	});

	test("an ownerless key without manage is never an admin", async () => {
		const c = await seedCallers();
		expect(await roleOf(c.ownerlessObserve, "solo")).toBe("member");
		expect(await roleOf(c.ownerlessObserve, "team")).toBe("member");
	});

	test("a host credential is neither admin nor member", async () => {
		const hostId = crypto.randomUUID();
		await getDb()
			.insert(supervisors)
			.values({ id: hostId, hostName: "rp-host", platform: "linux", arch: "x64", version: "0" });
		const credential = await createSupervisorCredential(hostId, "rp-host-credential");
		const seen: string[] = [];
		const app = new Hono();
		app.use("*", requireSupervisorAuth());
		app.get("/probe", async (c) => {
			const authUser = (c as unknown as { get(key: string): unknown }).get("authUser") as AuthUser;
			seen.push(
				await resolveEffectiveRole(authUser, "solo"),
				await resolveEffectiveRole(authUser, "team"),
			);
			return c.json({ ok: true });
		});
		await app.request("/probe", { headers: bearerHeaders(credential.token) });
		expect(seen).toEqual(["none", "none"]);
	});

	test("DISABLE_AUTH makes the operator an admin", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const authUser = await getAuthUserFromHeaders(new Headers());
		if (!authUser) throw new Error("operator did not resolve");
		expect(await resolveEffectiveRole(authUser, "solo")).toBe("admin");
	});
});

describe("always-admin routes, both modes", () => {
	for (const mode of ["solo", "team"] as const) {
		describe(mode, () => {
			for (const [entry, { humanOnly }] of ALWAYS_ADMIN_ROUTES) {
				test(`${entry}${humanOnly ? " (human only)" : ""}`, async () => {
					if (mode === "team") await setStoredMode("team");
					const c = await seedCallers();
					const app = policyApp();

					expect(await call(app, entry, c.adminCookie)).toEqual(OPEN);
					expect(await call(app, entry, c.memberCookie)).toEqual(adminRequired);
					expect(await call(app, entry, c.memberKey)).toEqual(adminRequired);
					expect(await call(app, entry, c.ownerlessObserve)).toEqual(adminRequired);
					expect(await call(app, entry, c.adminKey)).toEqual(humanOnly ? humanAdminRequired : OPEN);

					if (mode === "solo") {
						expect(await call(app, entry, c.ownerlessManage)).toEqual(
							humanOnly ? humanAdminRequired : OPEN,
						);
					} else {
						// Team: an unlisted ownerless manage key is a plain member.
						expect(await call(app, entry, c.ownerlessManage)).toEqual(adminRequired);
						await setAdminServiceKeyList([c.ownerlessManageId]);
						expect(await call(app, entry, c.ownerlessManage)).toEqual(
							humanOnly ? humanAdminRequired : OPEN,
						);
					}
				});
			}
		});
	}

	test("demoting an admin takes admin power from their keys on the very next request", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("rp-demote", "admin");
		const other = await seedLocalUser("rp-demote-other", "admin");
		const { key } = await seedKey("rp-demote-key", ["manage"], admin.id);
		const app = policyApp();
		const headers = bearerHeaders(key);

		expect(await call(app, "PATCH /sessions/:sessionId/owner", headers)).toEqual(OPEN);
		expect(await call(app, "PUT /ai/status", headers)).toEqual(OPEN);
		await setUserRoleDirectly(admin.id, "user");
		expect(await call(app, "PATCH /sessions/:sessionId/owner", headers)).toEqual(adminRequired);
		expect(await call(app, "PUT /ai/status", headers)).toEqual(adminRequired);
		expect(other.id).not.toBe(admin.id);
	});

	test("the DISABLE_AUTH operator is an admin and counts as human", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const app = policyApp();
		for (const entry of ALWAYS_ADMIN_ROUTES.keys()) {
			expect(await call(app, entry, new Headers())).toEqual(OPEN);
		}
	});

	test("a host credential is refused on an always-admin route", async () => {
		const hostId = crypto.randomUUID();
		await getDb()
			.insert(supervisors)
			.values({ id: hostId, hostName: "rp-host-2", platform: "linux", arch: "x64", version: "0" });
		const credential = await createSupervisorCredential(hostId, "rp-host-2-credential");
		const app = new Hono();
		app.use("*", requireSupervisorAuth());
		app.use("*", requireRolePolicy());
		app.patch("/sessions/:sessionId/owner", (c) => c.json({ reached: true }));
		const res = await app.request("/sessions/abc/owner", {
			method: "PATCH",
			headers: bearerHeaders(credential.token),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("admin_required");
	});
});

describe("team-admin routes", () => {
	for (const entry of TEAM_ADMIN_ROUTES) {
		test(`${entry}: open to everyone in solo`, async () => {
			const c = await seedCallers();
			const app = policyApp();
			for (const headers of [c.adminCookie, c.memberCookie, c.memberKey, c.ownerlessManage]) {
				expect(await call(app, entry, headers)).toEqual(OPEN);
			}
		});

		test(`${entry}: admin only in team`, async () => {
			await setStoredMode("team");
			const c = await seedCallers();
			const app = policyApp();
			expect(await call(app, entry, c.adminCookie)).toEqual(OPEN);
			expect(await call(app, entry, c.adminKey)).toEqual(OPEN);
			expect(await call(app, entry, c.memberCookie)).toEqual(adminRequired);
			expect(await call(app, entry, c.memberKey)).toEqual(adminRequired);
			expect(await call(app, entry, c.ownerlessManage)).toEqual(adminRequired);
			await setAdminServiceKeyList([c.ownerlessManageId]);
			expect(await call(app, entry, c.ownerlessManage)).toEqual(OPEN);
		});
	}

	test("a host credential is refused on a team-admin route in team mode", async () => {
		await setStoredMode("team");
		const hostId = crypto.randomUUID();
		await getDb()
			.insert(supervisors)
			.values({ id: hostId, hostName: "rp-host-3", platform: "linux", arch: "x64", version: "0" });
		const credential = await createSupervisorCredential(hostId, "rp-host-3-credential");
		const app = new Hono();
		app.use("*", requireSupervisorAuth());
		app.use("*", requireRolePolicy());
		app.put("/ai/status", (c) => c.json({ reached: true }));
		const res = await app.request("/ai/status", {
			method: "PUT",
			headers: bearerHeaders(credential.token),
		});
		expect(res.status).toBe(403);
	});

	test("the switch takes effect on the very next request, with no cache", async () => {
		const c = await seedCallers();
		const app = policyApp();
		expect(await call(app, "PUT /ai/status", c.memberCookie)).toEqual(OPEN);
		await setStoredMode("team");
		expect(await call(app, "PUT /ai/status", c.memberCookie)).toEqual(adminRequired);
		await setStoredMode("solo");
		expect(await call(app, "PUT /ai/status", c.memberCookie)).toEqual(OPEN);
	});

	test("AGENTPULSE_MODE=team applies without any stored setting", async () => {
		process.env[MODE_ENV] = "team";
		const c = await seedCallers();
		const app = policyApp();
		expect(await call(app, "PUT /ai/status", c.memberCookie)).toEqual(adminRequired);
	});
});

describe("the policy on the real app", () => {
	test("PUT /settings/workspace is admin only in team mode and open in solo", async () => {
		const { app } = await import("../app.js");
		const c = await seedCallers();
		const put = (headers: Headers) => {
			const h = new Headers(headers);
			h.set("Content-Type", "application/json");
			return app.request("/api/v1/settings/workspace", {
				method: "PUT",
				headers: h,
				body: JSON.stringify({}),
			});
		};
		expect((await put(c.memberCookie)).status).toBe(200);
		await setStoredMode("team");
		const refused = await put(c.memberCookie);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("admin_required");
		expect((await put(c.adminCookie)).status).toBe(200);
	});

	test("scratch cleanup (POST /projects/:id/cleanup-workarea) is a team-admin route: a member is refused in team mode, an admin is let through", async () => {
		const { app } = await import("../app.js");
		const c = await seedCallers();
		const post = (headers: Headers) =>
			app.request("/api/v1/projects/no-such-project/cleanup-workarea", {
				method: "POST",
				headers,
			});
		expect((await post(c.memberCookie)).status).not.toBe(403);
		await setStoredMode("team");
		const refused = await post(c.memberCookie);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("admin_required");
		expect((await post(c.adminCookie)).status).not.toBe(403);
	});

	test("a host-management route on the admin router is judged too", async () => {
		const { app } = await import("../app.js");
		const c = await seedCallers();
		await setStoredMode("team");
		const res = await app.request("/api/v1/admin/supervisors/abc", {
			method: "PATCH",
			headers: c.memberCookie,
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("admin_required");
	});
});

describe("GET /auth/me reports the caller's authority and the instance mode", () => {
	type Me = {
		user: { effectiveRole?: string; mustChangePassword?: boolean } | null;
		mode?: string;
		modeLockedByEnv?: boolean;
	};
	async function me(headers: Headers): Promise<Me> {
		const { app } = await import("../app.js");
		const res = await app.request("/api/v1/auth/me", { headers });
		return (await res.json()) as Me;
	}

	test("solo, local admin and member", async () => {
		const c = await seedCallers();
		const admin = await me(c.adminCookie);
		expect(admin.user?.effectiveRole).toBe("admin");
		expect(admin.mode).toBe("solo");
		expect(admin.modeLockedByEnv).toBe(false);
		expect((await me(c.memberCookie)).user?.effectiveRole).toBe("member");
	});

	test("team, a member is a member and an unlisted ownerless manage key is too", async () => {
		await setStoredMode("team");
		const c = await seedCallers();
		const member = await me(c.memberCookie);
		expect(member.user?.effectiveRole).toBe("member");
		expect(member.mode).toBe("team");
		expect((await me(c.ownerlessManage)).user?.effectiveRole).toBe("member");
		await setAdminServiceKeyList([c.ownerlessManageId]);
		expect((await me(c.ownerlessManage)).user?.effectiveRole).toBe("admin");
		expect((await me(c.adminKey)).user?.effectiveRole).toBe("admin");
	});

	test("an env-locked mode says so", async () => {
		process.env[MODE_ENV] = "team";
		const c = await seedCallers();
		const body = await me(c.adminCookie);
		expect(body.mode).toBe("team");
		expect(body.modeLockedByEnv).toBe(true);
	});

	test("DISABLE_AUTH reports an admin in solo", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const body = await me(new Headers());
		expect(body.user?.effectiveRole).toBe("admin");
		expect(body.mode).toBe("solo");
	});
});
