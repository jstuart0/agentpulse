/**
 * API keys and who they belong to: the list (all of them in solo, as today;
 * your own in team, everyone's for an admin), one key, minting (owned by the
 * caller; `service` for a key with no owner, which needs an admin, and a
 * manage service key needs a human admin and joins the kept admin list),
 * the admin's PATCH (owner, attributing the sessions a service key reported,
 * the kept-admin-list flag) and revoking (owner or admin in team mode).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { apiKeys, sessions, settings } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

const originalDisableAuth = config.disableAuth;
const LIST_KEY = "instance.adminServiceKeyIds";

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

interface World {
	admin: { id: string; cookie: Headers };
	member: { id: string; cookie: Headers };
	other: { id: string; cookie: Headers };
	adminKey: Headers;
	memberKey: { id: string; headers: Headers };
	service: { id: string; headers: Headers };
	listed: { id: string; headers: Headers };
}

async function world(): Promise<World> {
	const admin = await seedLocalUser("ak-admin", "admin");
	const member = await seedLocalUser("ak-member");
	const other = await seedLocalUser("ak-other");
	const adminKey = await seedKey("ak-admin-key", ["manage"], admin.id);
	const memberKey = await seedKey("ak-member-key", ["manage"], member.id);
	const service = await seedKey("ak-service", ["manage"]);
	const listed = await seedKey("ak-listed", ["manage"]);
	await setAdminServiceKeyList([listed.id]);
	return {
		admin: { id: admin.id, cookie: await cookieHeadersFor(admin.id) },
		member: { id: member.id, cookie: await cookieHeadersFor(member.id) },
		other: { id: other.id, cookie: await cookieHeadersFor(other.id) },
		adminKey: bearerHeaders(adminKey.key),
		memberKey: { id: memberKey.id, headers: bearerHeaders(memberKey.key) },
		service: { id: service.id, headers: bearerHeaders(service.key) },
		listed: { id: listed.id, headers: bearerHeaders(listed.key) },
	};
}

async function keyRow(id: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id));
	return row;
}

async function keptList(): Promise<string[]> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, LIST_KEY));
	return (row?.value as string[] | undefined) ?? [];
}

type Listed = {
	id: string;
	ownerUserId: string | null;
	createdByUserId: string | null;
	adminService: boolean;
};
async function list(headers: Headers, query = ""): Promise<Listed[]> {
	const res = await app.request(`/api/v1/api-keys${query}`, { headers });
	expect(res.status).toBe(200);
	return ((await res.json()) as { keys: Listed[] }).keys;
}

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));

describe("GET /api-keys", () => {
	test("solo: every key, as today, with the owner, creator and admin-service fields added", async () => {
		const w = await world();
		const keys = await list(w.member.cookie);
		expect(keys.length).toBe(4);
		const byId = new Map(keys.map((k) => [k.id, k]));
		expect(byId.get(w.memberKey.id)?.ownerUserId).toBe(w.member.id);
		expect(byId.get(w.memberKey.id)?.createdByUserId).toBe(w.member.id);
		expect(byId.get(w.service.id)?.ownerUserId).toBeNull();
		expect(byId.get(w.service.id)?.adminService).toBe(false);
		expect(byId.get(w.listed.id)?.adminService).toBe(true);
	});

	test("solo ignores ?owner=", async () => {
		const w = await world();
		expect((await list(w.member.cookie, `?owner=${w.other.id}`)).length).toBe(4);
	});

	test("team: a member sees their own keys, and nothing of anyone else's", async () => {
		await setStoredMode("team");
		const w = await world();
		const mine = await list(w.member.cookie);
		expect(mine.map((k) => k.id)).toEqual([w.memberKey.id]);
		expect(await list(w.other.cookie)).toEqual([]);
		expect((await list(w.memberKey.headers)).map((k) => k.id)).toEqual([w.memberKey.id]);
	});

	test("team: a key with no user (a service key that isn't kept) sees none", async () => {
		await setStoredMode("team");
		const w = await world();
		expect(await list(w.service.headers)).toEqual([]);
	});

	test("team: an admin (cookie, admin-owned key, kept service key) sees all, and ?owner= narrows", async () => {
		await setStoredMode("team");
		const w = await world();
		for (const headers of [w.admin.cookie, w.adminKey, w.listed.headers]) {
			expect((await list(headers)).length).toBe(4);
		}
		expect((await list(w.admin.cookie, `?owner=${w.member.id}`)).map((k) => k.id)).toEqual([
			w.memberKey.id,
		]);
		const services = await list(w.admin.cookie, "?owner=service");
		expect(services.map((k) => k.id).sort()).toEqual([w.service.id, w.listed.id].sort());
	});

	test("never carries a key's secret or hash", async () => {
		const w = await world();
		const res = await app.request("/api/v1/api-keys", { headers: w.admin.cookie });
		const text = await res.text();
		expect(text).not.toContain("keyHash");
		expect(text).not.toContain("key_hash");
	});
});

describe("GET /api-keys/:id", () => {
	test("team: the owner and an admin may read it, another member may not, a service key is an admin's", async () => {
		await setStoredMode("team");
		const w = await world();
		const get = (id: string, headers: Headers) =>
			app.request(`/api/v1/api-keys/${id}`, { headers });

		const own = await get(w.memberKey.id, w.member.cookie);
		expect(own.status).toBe(200);
		expect(((await own.json()) as { key: { id: string } }).key.id).toBe(w.memberKey.id);
		expect((await get(w.memberKey.id, w.admin.cookie)).status).toBe(200);

		// Not yours answers exactly as missing does.
		const refused = await get(w.memberKey.id, w.other.cookie);
		expect(refused.status).toBe(404);
		expect(await refused.json()).toEqual({ error: "API key not found" });

		expect((await get(w.service.id, w.admin.cookie)).status).toBe(200);
		expect((await get(w.service.id, w.member.cookie)).status).toBe(404);
		expect((await get("no-such-key", w.admin.cookie)).status).toBe(404);
	});

	test("counts the sessions attributed to the key as a service key", async () => {
		const w = await world();
		const insert = (sessionId: string, owner: string | null, key: string | null) =>
			getDb()
				.insert(sessions)
				.values({ sessionId, agentType: "claude_code", ownerUserId: owner, ingestKeyId: key });
		await insert("ak-count-1", null, w.service.id);
		await insert("ak-count-2", null, w.service.id);
		await insert("ak-count-owned", w.member.id, w.service.id);
		await insert("ak-count-other-key", null, w.listed.id);
		const res = await app.request(`/api/v1/api-keys/${w.service.id}`, { headers: w.admin.cookie });
		expect(((await res.json()) as { serviceSessionCount: number }).serviceSessionCount).toBe(2);
	});
});

describe("POST /api-keys", () => {
	type Minted = { id: string; key: string; ownerUserId?: string | null; service?: boolean };

	test("a key is owned by whoever minted it, and created by them", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "mine", scopes: ["ingest"] },
			w.member.cookie,
		);
		expect(res.status).toBe(200);
		const minted = (await res.json()) as Minted;
		expect(minted.ownerUserId).toBe(w.member.id);
		const row = await keyRow(minted.id);
		expect(row?.ownerUserId).toBe(w.member.id);
		expect(row?.createdByUserId).toBe(w.member.id);
	});

	test("service: true needs an admin, in both modes", async () => {
		for (const mode of ["solo", "team"] as const) {
			if (mode === "team") await setStoredMode("team");
			const w = await world();
			const asMember = await call(
				"/api-keys",
				"POST",
				{ name: "svc", scopes: ["ingest"], service: true },
				w.member.cookie,
			);
			expect({ mode, status: asMember.status }).toEqual({ mode, status: 403 });
			expect(((await asMember.json()) as { error: string }).error).toBe("admin_required");
			const asMemberKey = await call(
				"/api-keys",
				"POST",
				{ name: "svc", scopes: ["ingest"], service: true },
				w.memberKey.headers,
			);
			expect(asMemberKey.status).toBe(403);
			await reset();
		}
	});

	test("an admin's service key has no owner, remembers its creator, and is not listed unless it can manage", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "svc-ingest", scopes: ["ingest"], service: true },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		const minted = (await res.json()) as Minted;
		expect(minted.ownerUserId).toBeNull();
		const row = await keyRow(minted.id);
		expect(row?.ownerUserId).toBeNull();
		expect(row?.createdByUserId).toBe(w.admin.id);
		expect(await keptList()).not.toContain(minted.id);

		// A key (even an admin-owned one) never mints a service key.
		const viaKey = await call(
			"/api-keys",
			"POST",
			{ name: "svc-2", scopes: ["observe"], service: true },
			w.adminKey,
		);
		expect(viaKey.status).toBe(403);
	});

	test("a manage service key needs a human admin, and joins the kept admin list", async () => {
		const w = await world();
		const viaKey = await call(
			"/api-keys",
			"POST",
			{ name: "svc-m", scopes: ["manage"], service: true },
			w.adminKey,
		);
		expect(viaKey.status).toBe(403);
		expect(((await viaKey.json()) as { error: string }).error).toBe("human_admin_required");
		const viaListed = await call(
			"/api-keys",
			"POST",
			{ name: "svc-m2", scopes: ["manage"], service: true },
			w.listed.headers,
		);
		expect(viaListed.status).toBe(403);

		const res = await call(
			"/api-keys",
			"POST",
			{ name: "svc-m3", scopes: ["ingest", "manage"], service: true },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		const minted = (await res.json()) as Minted;
		expect((await keyRow(minted.id))?.ownerUserId).toBeNull();
		expect(await keptList()).toContain(minted.id);
	});

	test("a caller with no user id always makes a service key; in team mode it must be an admin", async () => {
		const w = await world();
		// Solo: as today, the ownerless caller's key is ownerless.
		const solo = await call(
			"/api-keys",
			"POST",
			{ name: "from-service", scopes: ["ingest"] },
			w.service.headers,
		);
		expect(solo.status).toBe(200);
		expect((await keyRow(((await solo.json()) as Minted).id))?.ownerUserId).toBeNull();

		await setStoredMode("team");
		const refused = await call(
			"/api-keys",
			"POST",
			{ name: "nope", scopes: ["ingest"] },
			w.service.headers,
		);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("admin_required");
		const allowed = await call(
			"/api-keys",
			"POST",
			{ name: "from-listed", scopes: ["ingest"] },
			w.listed.headers,
		);
		expect(allowed.status).toBe(200);
	});

	test("DISABLE_AUTH's operator mints a service key", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "operator", scopes: ["ingest"] },
			new Headers(),
		);
		expect(res.status).toBe(200);
		expect((await keyRow(((await res.json()) as Minted).id))?.ownerUserId).toBeNull();
	});

	test("an unknown scope, the wildcard and a missing name are refused as before", async () => {
		const w = await world();
		expect(
			(await call("/api-keys", "POST", { name: "x", scopes: ["root"] }, w.member.cookie)).status,
		).toBe(400);
		expect(
			(await call("/api-keys", "POST", { name: "x", scopes: ["*"] }, w.member.cookie)).status,
		).toBe(400);
		expect((await call("/api-keys", "POST", { name: "  " }, w.member.cookie)).status).toBe(400);
	});
});

describe("PATCH /api-keys/:id", () => {
	test("an admin hands a service key to a user, which takes it off the kept list", async () => {
		const w = await world();
		const res = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		expect((await keyRow(w.listed.id))?.ownerUserId).toBe(w.member.id);
		expect(await keptList()).not.toContain(w.listed.id);
	});

	test("null makes a key a service key", async () => {
		const w = await world();
		const res = await call(
			`/api-keys/${w.memberKey.id}`,
			"PATCH",
			{ ownerUserId: null },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		expect((await keyRow(w.memberKey.id))?.ownerUserId).toBeNull();
	});

	test("attributeSessions gives the user the sessions the key reported while it had no owner, and only those", async () => {
		const w = await world();
		const insert = (sessionId: string, owner: string | null, key: string | null) =>
			getDb()
				.insert(sessions)
				.values({ sessionId, agentType: "claude_code", ownerUserId: owner, ingestKeyId: key });
		await insert("pa-1", null, w.service.id);
		await insert("pa-2", null, w.service.id);
		await insert("pa-owned", w.other.id, w.service.id);
		await insert("pa-else", null, w.listed.id);
		const res = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ ownerUserId: w.member.id, attributeSessions: true },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { attributedSessions: number }).attributedSessions).toBe(2);
		const owner = async (id: string) =>
			(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0]?.ownerUserId ??
			null;
		expect(await owner("pa-1")).toBe(w.member.id);
		expect(await owner("pa-2")).toBe(w.member.id);
		expect(await owner("pa-owned")).toBe(w.other.id);
		expect(await owner("pa-else")).toBeNull();

		const without = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ attributeSessions: true },
			w.admin.cookie,
		);
		expect(without.status).toBe(400);
	});

	test("an unknown or disabled target, and an unknown key", async () => {
		const w = await world();
		await disableUserDirectly(w.other.id);
		const disabled = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ ownerUserId: w.other.id },
			w.admin.cookie,
		);
		expect(disabled.status).toBe(409);
		expect(((await disabled.json()) as { error: string }).error).toBe("user_disabled");
		expect((await keyRow(w.service.id))?.ownerUserId).toBeNull();
		const unknown = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ ownerUserId: "nope" },
			w.admin.cookie,
		);
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as { error: string }).error).toBe("user_not_found");
		expect(
			(await call("/api-keys/no-such-key", "PATCH", { ownerUserId: null }, w.admin.cookie)).status,
		).toBe(404);
	});

	test("adminService lists and delists an ownerless manage key, for a human admin only", async () => {
		const w = await world();
		const on = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ adminService: true },
			w.admin.cookie,
		);
		expect(on.status).toBe(200);
		expect(await keptList()).toContain(w.service.id);
		const off = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ adminService: false },
			w.admin.cookie,
		);
		expect(off.status).toBe(200);
		expect(await keptList()).not.toContain(w.service.id);

		for (const headers of [w.adminKey, w.listed.headers]) {
			const refused = await call(
				`/api-keys/${w.service.id}`,
				"PATCH",
				{ adminService: true },
				headers,
			);
			expect(refused.status).toBe(403);
			expect(((await refused.json()) as { error: string }).error).toBe("human_admin_required");
		}
		expect(await keptList()).not.toContain(w.service.id);
	});

	test("adminService is refused on an owned key (409 key_has_owner) and on a key that can't manage (409 key_not_manage)", async () => {
		const w = await world();
		const owned = await call(
			`/api-keys/${w.memberKey.id}`,
			"PATCH",
			{ adminService: true },
			w.admin.cookie,
		);
		expect(owned.status).toBe(409);
		expect(((await owned.json()) as { error: string }).error).toBe("key_has_owner");
		const ingest = await seedKey("ak-ingest-only", ["ingest"]);
		const notManage = await call(
			`/api-keys/${ingest.id}`,
			"PATCH",
			{ adminService: true },
			w.admin.cookie,
		);
		expect(notManage.status).toBe(409);
		expect(((await notManage.json()) as { error: string }).error).toBe("key_not_manage");
	});

	test("an empty patch, or an owner together with adminService, is a 400", async () => {
		const w = await world();
		expect((await call(`/api-keys/${w.service.id}`, "PATCH", {}, w.admin.cookie)).status).toBe(400);
		const both = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ ownerUserId: w.member.id, adminService: true },
			w.admin.cookie,
		);
		expect(both.status).toBe(400);
	});

	test("an admin-owned key may hand an ingest-only key to a member, not a manage key; a member may not hand anything", async () => {
		const w = await world();
		const ingestOnly = await seedKey("ak-ingest-only", ["ingest"]);
		expect(
			(await call(`/api-keys/${w.service.id}`, "PATCH", { ownerUserId: w.member.id }, w.adminKey))
				.status,
		).toBe(403);
		expect(
			(await call(`/api-keys/${ingestOnly.id}`, "PATCH", { ownerUserId: w.member.id }, w.adminKey))
				.status,
		).toBe(200);
		const refused = await call(
			`/api-keys/${w.memberKey.id}`,
			"PATCH",
			{ ownerUserId: w.other.id },
			w.member.cookie,
		);
		expect(refused.status).toBe(403);
		expect((await keyRow(w.memberKey.id))?.ownerUserId).toBe(w.member.id);
	});

	test("a foreign Origin is refused", async () => {
		const w = await world();
		const headers = new Headers(w.admin.cookie);
		headers.set("Origin", "https://evil.example.test");
		const res = await call(
			`/api-keys/${w.service.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			headers,
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
	});

	test("the change is logged against the acting admin", async () => {
		const w = await world();
		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			await call(
				`/api-keys/${w.service.id}`,
				"PATCH",
				{ ownerUserId: w.member.id },
				w.admin.cookie,
			);
		} finally {
			spy.mockRestore();
		}
		const audit = lines
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.find((line) => line?.kind === "api_key_updated");
		expect(audit?.by).toBe(w.admin.id);
		expect(audit?.keyId).toBe(w.service.id);
	});
});

describe("DELETE /api-keys/:id", () => {
	const del = (id: string, headers: Headers) =>
		app.request(`/api/v1/api-keys/${id}`, { method: "DELETE", headers });

	test("solo is unchanged: any caller may revoke any key", async () => {
		const w = await world();
		expect((await del(w.memberKey.id, w.other.cookie)).status).toBe(200);
		expect((await keyRow(w.memberKey.id))?.isActive).toBe(false);
	});

	test("team: the owner and an admin may; another member and a member's key may not", async () => {
		await setStoredMode("team");
		const w = await world();
		const refused = await del(w.memberKey.id, w.other.cookie);
		// "Not yours" answers exactly as "doesn't exist".
		expect(refused.status).toBe(404);
		expect(await refused.json()).toEqual({ error: "API key not found" });
		const missing = await del("no-such-key", w.other.cookie);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "API key not found" });
		expect((await keyRow(w.memberKey.id))?.isActive).toBe(true);

		expect((await del(w.memberKey.id, w.member.cookie)).status).toBe(200);
		expect((await keyRow(w.memberKey.id))?.isActive).toBe(false);

		const minted = await seedKey("ak-del-2", ["ingest"], w.member.id);
		expect((await del(minted.id, w.admin.cookie)).status).toBe(200);
		const minted3 = await seedKey("ak-del-3", ["ingest"], w.member.id);
		expect((await del(minted3.id, w.adminKey)).status).toBe(200);
	});

	test("team: a service key is an admin's to revoke, and revoking a kept one takes it off the list", async () => {
		await setStoredMode("team");
		const w = await world();
		expect((await del(w.service.id, w.member.cookie)).status).toBe(404);
		expect((await keyRow(w.service.id))?.isActive).toBe(true);
		expect((await del(w.listed.id, w.admin.cookie)).status).toBe(200);
		expect(await keptList()).not.toContain(w.listed.id);
	});

	test("an unknown key is 404 in either mode", async () => {
		const w = await world();
		expect((await del("no-such-key", w.admin.cookie)).status).toBe(404);
		await setStoredMode("team");
		expect((await del("no-such-key", w.member.cookie)).status).toBe(404);
	});
});
