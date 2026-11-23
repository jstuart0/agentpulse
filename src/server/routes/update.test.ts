/**
 * POST /update/check: the one control the server gives about updates, and all it does is ask the
 * server to look at the release feed now. It starts nothing and changes nothing on any machine.
 * Admin in both modes, not human-only; a foreign Origin is refused; under auth off only a loopback
 * Host may call it; one a minute per process, spent only after every check that could refuse it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import {
	NOW,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
} from "../../shared/__fixtures__/release-test-signer.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";
import {
	fixtureSource,
	manualScheduler,
	memoryUpdateStore,
} from "../test-utils/update-fixtures.js";

const { initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { ALWAYS_ADMIN_ROUTES } = await import("../auth/route-scope-policy.js");
const { createUpdateChecker, setUpdateCheckerForTests } = await import(
	"../services/update-check.js"
);
const { resetUpdateCheckLimiterForTests, setUpdateCheckLimiterClockForTests } = await import(
	"./update.js"
);

const URL_ = "/api/v1/update/check";
const originalDisableAuth = config.disableAuth;
const clock = { now: 1_000_000 };
let source: ReturnType<typeof fixtureSource>;

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
	await clearInstanceSettings();
	clock.now = 1_000_000;
	setUpdateCheckLimiterClockForTests(() => clock.now);
	resetUpdateCheckLimiterForTests();
	source = fixtureSource(envelopeFor(testPayload()));
	setUpdateCheckerForTests(
		createUpdateChecker({
			source,
			store: memoryUpdateStore(),
			keys: TEST_KEY_LIST,
			currentVersion: "0.11.0",
			install: () => ({ kind: "local", track: "release" }),
			enabled: () => true,
			now: () => NOW,
			random: () => 0.5,
			schedule: manualScheduler().schedule,
			log: () => {},
		}),
	);
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	setUpdateCheckerForTests(null);
	setUpdateCheckLimiterClockForTests(null);
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

const post = (headers: Headers = new Headers()) => app.request(URL_, { method: "POST", headers });

describe("classification", () => {
	test("it is an always-admin route, and not human-only", () => {
		expect(ALWAYS_ADMIN_ROUTES.get("POST /update/check")).toEqual({ humanOnly: false });
	});
});

describe("who may call it (auth on)", () => {
	test("an admin's manage key (solo: any ownerless manage key) gets 200 and the status", async () => {
		const { key } = await seedKey("up-manage", ["manage"]);
		const res = await post(bearerHeaders(key));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { update: Record<string, unknown> };
		expect(body.update).toMatchObject({ current: "0.11.0", latest: "0.12.0", state: "available" });
		expect(source.fetches).toBe(1);
	});

	test("observe, respond and ingest keys are refused 403 and nothing is fetched", async () => {
		for (const scopes of [["observe"], ["respond"], ["ingest"]]) {
			const { key } = await seedKey(`up-${scopes[0]}`, scopes);
			expect({ scopes, status: (await post(bearerHeaders(key))).status }).toEqual({
				scopes,
				status: 403,
			});
		}
		expect(source.fetches).toBe(0);
	});

	test("no credential is 401", async () => {
		expect((await post()).status).toBe(401);
		expect(source.fetches).toBe(0);
	});

	test("a member in team mode is refused admin_required; an admin is let in", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("up-member");
		const admin = await seedLocalUser("up-admin", "admin");
		const refused = await post(await cookieHeadersFor(member.id));
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("admin_required");
		expect(source.fetches).toBe(0);
		expect((await post(await cookieHeadersFor(admin.id))).status).toBe(200);
	});

	test("a foreign Origin is refused bad_origin, before the budget and the fetch", async () => {
		const { key } = await seedKey("up-origin", ["manage"]);
		const headers = bearerHeaders(key, { Origin: "https://evil.example" });
		const res = await post(headers);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		expect(source.fetches).toBe(0);
		// The refused call spent nothing: an allowed one still goes through.
		expect((await post(bearerHeaders(key))).status).toBe(200);
	});
});

describe("under DISABLE_AUTH: only a loopback Host", () => {
	const asLocal = async (host?: string) => {
		(config as Record<string, unknown>).disableAuth = true;
		return post(host === undefined ? new Headers() : new Headers({ Host: host }));
	};

	for (const host of ["192.168.1.5:3000", "localhost.evil.com", "127.0.0.1.nip.io", undefined]) {
		test(`Host ${host ?? "(none)"} is refused 403 and nothing is fetched`, async () => {
			const res = await asLocal(host);
			expect(res.status).toBe(403);
			expect(source.fetches).toBe(0);
		});
	}

	for (const host of ["127.0.0.1:3000", "[::1]:3000", "localhost:3000"]) {
		test(`Host ${host} is allowed`, async () => {
			const res = await asLocal(host);
			expect(res.status).toBe(200);
			expect(source.fetches).toBe(1);
		});
	}

	test("a refused Host doesn't spend the budget", async () => {
		expect((await asLocal("192.168.1.5:3000")).status).toBe(403);
		expect((await asLocal("127.0.0.1:3000")).status).toBe(200);
	});
});

describe("the route's own Origin check, without the role policy in front of it", () => {
	test("a foreign Origin is refused by the route itself, and nothing is fetched", async () => {
		const { Hono } = await import("hono");
		const { updateRouter } = await import("./update.js");
		(config as Record<string, unknown>).disableAuth = true;
		const bare = new Hono().route("/api/v1", updateRouter);
		const res = await bare.request(URL_, {
			method: "POST",
			headers: new Headers({ Host: "127.0.0.1:3000", Origin: "https://evil.example" }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		expect(source.fetches).toBe(0);
	});
});

describe("one a minute per process", () => {
	test("a second allowed call inside the minute is 429 with Retry-After, and fetches nothing", async () => {
		const { key } = await seedKey("up-rate", ["manage"]);
		expect((await post(bearerHeaders(key))).status).toBe(200);
		clock.now += 20_000;
		const second = await post(bearerHeaders(key));
		expect(second.status).toBe(429);
		expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
		expect(Number(second.headers.get("Retry-After"))).toBe(40);
		expect(source.fetches).toBe(1);
	});

	test("after the minute, it is allowed again", async () => {
		const { key } = await seedKey("up-rate2", ["manage"]);
		await post(bearerHeaders(key));
		clock.now += 60_001;
		expect((await post(bearerHeaders(key))).status).toBe(200);
		expect(source.fetches).toBe(2);
	});

	test("a call that fails authorisation doesn't spend the minute for a real admin", async () => {
		const observe = await seedKey("up-rate-observe", ["observe"]);
		const manage = await seedKey("up-rate-manage", ["manage"]);
		expect((await post(bearerHeaders(observe.key))).status).toBe(403);
		expect((await post(bearerHeaders(manage.key))).status).toBe(200);
	});
});

describe("it only looks at the feed", () => {
	test("with the check switched off it answers disabled and fetches nothing", async () => {
		setUpdateCheckerForTests(
			createUpdateChecker({
				source,
				store: memoryUpdateStore(),
				keys: TEST_KEY_LIST,
				currentVersion: "0.11.0",
				install: () => ({ kind: "local", track: "release" }),
				enabled: () => false,
				now: () => NOW,
				random: () => 0.5,
				schedule: manualScheduler().schedule,
				log: () => {},
			}),
		);
		const { key } = await seedKey("up-off", ["manage"]);
		const res = await post(bearerHeaders(key));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { update: { state: string } }).update.state).toBe("disabled");
		expect(source.fetches).toBe(0);
	});

	test("the route module spawns nothing and imports nothing from the updater", async () => {
		const text = await Bun.file(new URL("./update.ts", import.meta.url)).text();
		expect(text).not.toMatch(/child_process|Bun\.spawn|spawnSync|from "\.\.\/\.\.\/updater/);
	});
});
