/**
 * The access gate: a user who must change their password gets nothing but the
 * change itself (and /auth/me and logout) until they do, whether they arrive
 * with a cookie or with one of their own API keys. Hook ingest is never gated.
 * A key whose owner is disabled stops working at resolve time even if the key
 * row itself was never switched off. The identity of a request is resolved
 * once, however many routers the request passes through.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	TEST_PASSWORD,
	bearerHeaders,
	cookieHeadersFor,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { config } = await import("../config.js");
const { Hono } = await import("hono");
const { requireAuth, getAuthUserFromHeaders } = await import("./middleware.js");
const { _setEnqueueHookProcessingOverrideForTest } = await import("../routes/ingest.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(resetIdentityState);

afterEach(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	_setEnqueueHookProcessingOverrideForTest(null);
});

const STATS = "/api/v1/sessions/stats";

describe("a flagged user's cookie", () => {
	test("is refused on bundle routes with password_change_required", async () => {
		const user = await seedLocalUser("gate-cookie", "user", { mustChangePassword: true });
		const res = await app.request(STATS, { headers: await cookieHeadersFor(user.id) });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "password_change_required" });
	});

	test("is refused on a route in a later router too (every router carries the gate)", async () => {
		const user = await seedLocalUser("gate-cookie-late", "user", { mustChangePassword: true });
		const headers = await cookieHeadersFor(user.id);
		for (const path of [
			"/api/v1/launches",
			"/api/v1/channels",
			"/api/v1/ai/status",
			"/api/v1/settings",
		]) {
			const res = await app.request(path, { headers });
			expect(res.status).toBe(403);
		}
	});

	test("still reaches /auth/me, which says why", async () => {
		const user = await seedLocalUser("gate-me", "user", { mustChangePassword: true });
		const res = await app.request("/api/v1/auth/me", { headers: await cookieHeadersFor(user.id) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { mustChangePassword: boolean } };
		expect(body.user.mustChangePassword).toBe(true);
	});

	test("can change the password, after which every route opens", async () => {
		const user = await seedLocalUser("gate-change", "user", { mustChangePassword: true });
		const headers = await cookieHeadersFor(user.id);
		const change = await app.request(
			"/api/v1/auth/change-password",
			jsonRequest(
				"POST",
				{ currentPassword: TEST_PASSWORD, newPassword: "Another-long-pass-9!" },
				headers,
			),
		);
		expect(change.status).toBe(200);
		const fresh = new Headers({ Cookie: (change.headers.get("set-cookie") ?? "").split(";")[0] });
		const after = await app.request(STATS, { headers: fresh });
		expect(after.status).toBe(200);
	});

	test("an unflagged user is not gated", async () => {
		const user = await seedLocalUser("gate-clear");
		const res = await app.request(STATS, { headers: await cookieHeadersFor(user.id) });
		expect(res.status).toBe(200);
	});
});

describe("a flagged user's own API key", () => {
	test("gets password_change_required on GET /sessions and still a 200 that is enqueued on POST /hooks", async () => {
		const user = await seedLocalUser("gate-key", "user", { mustChangePassword: true });
		const { key } = await seedKey("gate-key", ["ingest", "manage"], user.id);

		const read = await app.request("/api/v1/sessions", { headers: bearerHeaders(key) });
		expect(read.status).toBe(403);
		expect(await read.json()).toEqual({ error: "password_change_required" });

		const enqueued: string[] = [];
		_setEnqueueHookProcessingOverrideForTest(async (payload) => {
			enqueued.push(payload.session_id);
		});
		const hook = await app.request(
			"/api/v1/hooks",
			jsonRequest(
				"POST",
				{ session_id: "gate-hook-1", hook_event_name: "SessionStart" },
				bearerHeaders(key),
			),
		);
		expect(hook.status).toBe(200);
		expect(enqueued).toEqual(["gate-hook-1"]);

		const status = await app.request(
			"/api/v1/hooks/status",
			jsonRequest("POST", { session_id: "gate-hook-1", status: "working" }, bearerHeaders(key)),
		);
		expect(status.status).toBe(200);
	});

	test("a key of an unflagged user is not gated", async () => {
		const user = await seedLocalUser("gate-key-clear");
		const { key } = await seedKey("gate-key-clear", ["manage"], user.id);
		const res = await app.request(STATS, { headers: bearerHeaders(key) });
		expect(res.status).toBe(200);
	});

	test("an ownerless key is never gated", async () => {
		const { key } = await seedKey("gate-service", ["manage"]);
		const res = await app.request(STATS, { headers: bearerHeaders(key) });
		expect(res.status).toBe(200);
	});
});

describe("a key whose owner is disabled, with the key row itself still active", () => {
	test("is rejected at resolve time on the dashboard routes and on ingest", async () => {
		const user = await seedLocalUser("gate-disabled");
		const { id, key } = await seedKey("gate-disabled", ["ingest", "manage"], user.id);
		await disableUserDirectly(user.id);
		const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id));
		expect(row?.isActive).toBe(true);

		const read = await app.request(STATS, { headers: bearerHeaders(key) });
		expect(read.status).toBe(401);
		const hook = await app.request(
			"/api/v1/hooks",
			jsonRequest(
				"POST",
				{ session_id: "gate-disabled-1", hook_event_name: "SessionStart" },
				bearerHeaders(key),
			),
		);
		expect(hook.status).toBe(401);
	});
});

describe("the identity of a request is resolved once", () => {
	test("three requireAuth middlewares in a row cost what one does", async () => {
		const user = await seedLocalUser("gate-once");
		const headers = await cookieHeadersFor(user.id);

		const single = new Hono();
		single.use("*", requireAuth());
		single.get("/probe", (c) => c.json({ ok: true }));
		const triple = new Hono();
		triple.use("*", requireAuth());
		triple.use("*", requireAuth());
		triple.use("*", requireAuth());
		triple.get("/probe", (c) => c.json({ ok: true }));

		const one = await countDbCalls(async () => {
			expect((await single.request("/probe", { headers })).status).toBe(200);
		});
		const three = await countDbCalls(async () => {
			expect((await triple.request("/probe", { headers })).status).toBe(200);
		});
		expect(one).toBeGreaterThan(0);
		expect(three).toBe(one);
	});

	test("a request to a route in a later router resolves a cookie once", async () => {
		const user = await seedLocalUser("gate-once-real");
		const headers = await cookieHeadersFor(user.id);
		const resolveCost = await countDbCalls(async () => {
			await getAuthUserFromHeaders(headers);
		});
		const launchesCost = await countDbCalls(async () => {
			expect((await app.request("/api/v1/launches", { headers })).status).toBe(200);
		});
		// The route's own statements are few (one list select); anything near
		// a second or third resolve would blow past this bound.
		expect(launchesCost).toBeLessThanOrEqual(resolveCost + 3);
	});
});

describe("statement cost of resolving a key", () => {
	test("an owned key costs the same as an ownerless one: the owner's state rides on the key lookup", async () => {
		const user = await seedLocalUser("gate-cost");
		const owned = await seedKey("gate-cost-owned", ["manage"], user.id);
		const ownerless = await seedKey("gate-cost-service", ["manage"]);

		const ownedCalls = await countDbCalls(async () => {
			expect((await getAuthUserFromHeaders(bearerHeaders(owned.key)))?.keyId).toBe(owned.id);
		});
		const ownerlessCalls = await countDbCalls(async () => {
			expect((await getAuthUserFromHeaders(bearerHeaders(ownerless.key)))?.keyId).toBe(
				ownerless.id,
			);
		});
		// The key select and the fire-and-forget last-used update.
		expect(ownedCalls).toBe(2);
		expect(ownerlessCalls).toBe(2);
	});

	test("the owner's current role and flag ride on the resolved identity", async () => {
		const admin = await seedLocalUser("gate-role", "admin");
		const { key } = await seedKey("gate-role", ["manage"], admin.id);
		const resolved = await getAuthUserFromHeaders(bearerHeaders(key));
		expect(resolved?.ownerRole).toBe("admin");
		expect(resolved?.mustChangePassword).toBe(false);

		const ownerless = await seedKey("gate-role-service", ["manage"]);
		expect((await getAuthUserFromHeaders(bearerHeaders(ownerless.key)))?.ownerRole).toBeNull();
	});
});
