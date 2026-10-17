/**
 * GET /capabilities: what the server can do and who is asking. Every feature it
 * advertises names the route that proves it, and that route must be mounted:
 * a flag with nothing behind it is a lie a native client would act on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const { handleServerRequest } = await import("../server-fetch.js");
const { seedKey, seedLocalUser, setStoredMode, clearInstanceSettings } = await import(
	"../test-utils/team-fixtures.js"
);
const { createApiKey } = await import("../auth/api-key.js");
const { SCOPE_GRANTS } = await import("../auth/route-scope-policy.js");
const { WS_UPGRADE_PATHS } = await import("../ws/ws-auth.js");
const { CAPABILITY_FEATURES, CAPABILITIES_API_LEVEL } = await import("./capabilities.js");

const originalDisableAuth = config.disableAuth;
const originalAi = { aiEnabled: config.aiEnabled, secretsKey: config.secretsKey };
let respondKey: string;
let observeKey: string;
let ingestKey: string;
let manageKey: string;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	respondKey = (await createApiKey("cap-respond", ["respond"])).key;
	observeKey = (await createApiKey("cap-observe", ["observe"])).key;
	ingestKey = (await createApiKey("cap-ingest", ["ingest"])).key;
	manageKey = (await createApiKey("cap-manage", ["manage"])).key;
});

afterEach(clearInstanceSettings);

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	Object.assign(config as Record<string, unknown>, originalAi);
});

const get = (key: string, mount = "/api/v1") =>
	app.request(`${mount}/capabilities`, { headers: { Authorization: `Bearer ${key}` } });

describe("the feature registry is backed by mounted routes", () => {
	const mountedRoutes = () =>
		new Set(
			app.routes.map(
				(route) => `${route.method} ${route.path.replace(/^\/(api|app-api)\/v1/, "")}`,
			),
		);

	test("every route-proved feature is mounted under both prefixes, and there is something to check", () => {
		const routes = [...mountedRoutes()];
		const proofs = CAPABILITY_FEATURES.flatMap((f) => (f.proof.kind === "route" ? [f.proof] : []));
		expect(proofs.length).toBeGreaterThan(0);
		for (const proof of proofs) {
			const key = `${proof.method} ${proof.path}`;
			expect({ key, mounted: routes.includes(key) }).toEqual({ key, mounted: true });
			for (const prefix of ["/api/v1", "/app-api/v1"]) {
				const full = app.routes.some(
					(r) => r.method === proof.method && r.path === `${prefix}${proof.path}`,
				);
				expect({ key, prefix, full }).toEqual({ key, prefix, full: true });
			}
		}
	});

	test("every ws-proved feature has a live upgrade path that answers as the socket guard, not as a missing page", async () => {
		expect(CAPABILITY_FEATURES.some((f) => f.proof.kind === "ws")).toBe(true);
		expect(WS_UPGRADE_PATHS.size).toBeGreaterThan(0);
		for (const path of WS_UPGRADE_PATHS) {
			const res = await handleServerRequest(new Request(`http://localhost${path}`), undefined);
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
	});

	test("a respond-prefixed feature is advertised only when its respond grant has landed", () => {
		const respondFeatures = CAPABILITY_FEATURES.filter((f) => f.name.startsWith("respond"));
		expect(respondFeatures.length).toBeGreaterThan(0);
		for (const feature of respondFeatures) {
			expect(feature.proof.kind).toBe("route");
			if (feature.proof.kind !== "route") continue;
			expect(SCOPE_GRANTS.respond.writes.has(`${feature.proof.method} ${feature.proof.path}`)).toBe(
				true,
			);
		}
		// S1 lands the acknowledge grant only: no decisions flag yet.
		expect(CAPABILITY_FEATURES.map((f) => f.name)).not.toContain("respondDecisions");
	});

	test("names are unique", () => {
		const names = CAPABILITY_FEATURES.map((f) => f.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("GET /capabilities", () => {
	test("answers the documented shape, under both mounts", async () => {
		for (const mount of ["/api/v1", "/app-api/v1"]) {
			const res = await get(respondKey, mount);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, any>;
			expect(Object.keys(body).sort()).toEqual(
				["ai", "apiLevel", "auth", "caller", "features", "mode", "pushEvents", "version"].sort(),
			);
			expect(body.apiLevel).toBe(CAPABILITIES_API_LEVEL);
			expect(typeof body.version).toBe("string");
			expect(["solo", "team"]).toContain(body.mode);
			expect(body.features).toEqual({
				wsNativeAuth: true,
				wsMobileProfile: true,
				pairing: true,
				respondAck: true,
			});
			expect(body.pushEvents).toEqual([]);
			expect(Object.keys(body.ai).sort()).toEqual(["active", "build", "provider", "vectorSearch"]);
			expect("labs" in body).toBe(false);
		}
	});

	test("says who is asking: a respond key is an api_key member holding exactly respond", async () => {
		const body = (await (await get(respondKey)).json()) as Record<string, any>;
		expect(body.caller).toEqual({
			source: "api_key",
			userId: null,
			role: null,
			effectiveRole: "member",
			scopes: ["respond"],
		});
	});

	test("never carries a secret: nothing of the requesting key, its id or its owner's credentials comes back", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("cap-secret-owner");
		const owned = await seedKey("cap-secret-respond", ["respond"], owner.id);
		const text = JSON.stringify(await (await get(owned.key)).json());
		expect(text).not.toContain(owned.key);
		expect(text).not.toContain(owned.key.slice(0, 8));
		expect(text).not.toContain(owned.id);
		expect(text.toLowerCase()).not.toContain("credential");
		expect(text.toLowerCase()).not.toContain("apikey");
		expect(text.toLowerCase()).not.toContain("hash");
	});

	test("team mode pins the caller: an owned respond key is its owner's id, a member, holding exactly respond", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("cap-caller-owner");
		const admin = await seedLocalUser("cap-caller-admin", "admin");
		const owned = await seedKey("cap-caller-respond", ["respond"], owner.id);
		const adminOwned = await seedKey("cap-caller-admin-respond", ["respond"], admin.id);
		const ownerless = await seedKey("cap-caller-loose", ["respond"], null);

		const body = async (key: string) => (await (await get(key)).json()) as Record<string, any>;
		expect((await body(owned.key)).mode).toBe("team");
		expect((await body(owned.key)).caller).toEqual({
			source: "api_key",
			userId: owner.id,
			role: null,
			effectiveRole: "member",
			scopes: ["respond"],
		});
		// an admin-owned key resolves to its owner's role, whatever its scope
		expect((await body(adminOwned.key)).caller.effectiveRole).toBe("admin");
		expect((await body(ownerless.key)).caller).toEqual({
			source: "api_key",
			userId: null,
			role: null,
			effectiveRole: "member",
			scopes: ["respond"],
		});
	});

	test("observe and manage keys read it; an ingest key and no credential do not", async () => {
		expect((await get(observeKey)).status).toBe(200);
		expect((await get(manageKey)).status).toBe(200);
		expect((await get(ingestKey)).status).toBe(403);
		expect((await app.request("/api/v1/capabilities")).status).toBe(401);
	});

	test("AI off still answers 200, with the AI block saying so", async () => {
		Object.assign(config as Record<string, unknown>, { aiEnabled: false, secretsKey: "" });
		const res = await get(respondKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, any>;
		expect(body.ai).toEqual({ build: false, active: false, provider: null, vectorSearch: false });
	});

	test("AI built in but not switched on is also a 200, active false", async () => {
		Object.assign(config as Record<string, unknown>, {
			aiEnabled: true,
			secretsKey: "k".repeat(32),
		});
		try {
			const body = (await (await get(respondKey)).json()) as Record<string, any>;
			expect(body.ai.build).toBe(true);
			expect(body.ai.active).toBe(false);
			expect(body.ai.provider).toBeNull();
		} finally {
			Object.assign(config as Record<string, unknown>, originalAi);
		}
	});
});
