/**
 * `/health` and `/capabilities` carry the update status. Both read it from memory (no database read of
 * their own for it) and neither lets an update problem change health. The checker under test is a real one
 * over the fixture source and the throwaway test key; nothing here touches the network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";
import { Hono } from "hono";
import {
	NOW,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
	testRelease,
} from "../../shared/__fixtures__/release-test-signer.js";
import { isKnownUpdateState } from "../../shared/update-status.js";
import { countDbCalls } from "../test-utils/db-call-counter.js";
import {
	fixtureSource,
	manualScheduler,
	memoryUpdateStore,
} from "../test-utils/update-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { health, markDbReady, _resetDbReadyForTest } = await import("./health.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { seedKey, seedLocalUser, setStoredMode, clearInstanceSettings } = await import(
	"../test-utils/team-fixtures.js"
);
const { createUpdateChecker, setUpdateCheckerForTests } = await import(
	"../services/update-check.js"
);

import pkg from "../../../package.json" with { type: "json" };

const pkgVersion: string = pkg.version;
const originalDisableAuth = config.disableAuth;
let observeKey: string;
let manageKey: string;

beforeAll(async () => {
	await initializeDatabase();
	markDbReady();
	(config as Record<string, unknown>).disableAuth = false;
	observeKey = (await createApiKey("update-routes-observe", ["observe"])).key;
	manageKey = (await createApiKey("update-routes-manage", ["manage"])).key;
});
afterAll(() => {
	_resetDbReadyForTest(false);
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	setUpdateCheckerForTests(null);
});
afterEach(() => setUpdateCheckerForTests(null));

const healthApp = new Hono().route("/api/v1", health);

function checker(source = fixtureSource(), over: Record<string, unknown> = {}) {
	const store = memoryUpdateStore();
	const c = createUpdateChecker({
		source,
		store,
		keys: TEST_KEY_LIST,
		currentVersion: "0.11.0",
		install: () => ({ kind: "container", track: null }),
		enabled: () => true,
		now: () => NOW,
		random: () => 0.5,
		schedule: manualScheduler().schedule,
		log: () => {},
		...over,
	});
	setUpdateCheckerForTests(c);
	return { c, store, source };
}

const STATES: Array<[string, string, Parameters<typeof testPayload>[0]]> = [
	["available", "0.11.0", {}],
	["current", "0.12.0", {}],
	[
		"security",
		"0.11.0",
		{ releases: [testRelease("0.12.0", { severity: "security" }), testRelease("0.11.0")] },
	],
	[
		"current_pulled",
		"0.11.0",
		{ releases: [testRelease("0.12.0"), testRelease("0.11.0", { pulled: true })] },
	],
	["below_minimum", "0.10.0", { minSupported: "0.11.0" }],
];

describe("GET /health", () => {
	test("always carries update {current, latest, state, stale, checkedAt}, and nothing else of it", async () => {
		checker();
		const body = await (await healthApp.request("/api/v1/health")).json();
		expect(Object.keys(body.update).sort()).toEqual([
			"checkedAt",
			"current",
			"latest",
			"stale",
			"state",
		]);
		expect(body.update).toMatchObject({
			latest: null,
			state: "unverified",
			stale: false,
			checkedAt: null,
		});
	});

	for (const [state, current, over] of STATES) {
		test(`the state ${state} reaches update.state`, async () => {
			const { c, source } = checker(undefined, { currentVersion: current });
			source.push(envelopeFor(testPayload(over)));
			await c.checkNow();
			const res = await healthApp.request("/api/v1/health");
			const body = await res.json();
			expect(res.status).toBe(200);
			expect(body.status).toBe("ok");
			expect(body.update.state).toBe(state);
			expect(body.update.current).toBe(current);
		});
	}

	test("a disabled check reads as disabled and health stays ok", async () => {
		checker(undefined, { enabled: () => false });
		const body = await (await healthApp.request("/api/v1/health")).json();
		expect(body.status).toBe("ok");
		expect(body.update.state).toBe("disabled");
	});

	test("an unreachable manifest doesn't change health: still 200 and ok", async () => {
		const { c, source } = checker();
		source.push({ fail: "network" });
		await c.checkNow();
		const res = await healthApp.request("/api/v1/health");
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.update.state).toBe("unverified");
	});

	test("a pulled or security state never degrades the health status", async () => {
		const { c, source } = checker();
		source.push(
			envelopeFor(
				testPayload({ releases: [testRelease("0.12.0"), testRelease("0.11.0", { pulled: true })] }),
			),
		);
		await c.checkNow();
		const body = await (await healthApp.request("/api/v1/health")).json();
		expect(body.status).toBe("ok");
	});

	test("update adds no database read: the status and envelope reads issue no statement, and a checker whose store throws still answers", async () => {
		const { c, source, store } = checker();
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
		const { getUpdateStatus, getSignedEnvelope } = await import("../services/update-check.js");
		expect(
			await countDbCalls(async () => {
				getUpdateStatus();
				getSignedEnvelope();
			}),
		).toBe(0);
		store.load = async () => {
			throw new Error("the health route must not read update state from the database");
		};
		store.save = async () => {
			throw new Error("the health route must not write update state");
		};
		const res = await healthApp.request("/api/v1/health?manifest=1");
		expect(res.status).toBe(200);
		expect((await res.json()).update.state).toBe("available");
	});

	test("a checker that throws falls back to the unverified block and health stays ok", async () => {
		setUpdateCheckerForTests({
			start: () => () => {},
			whenReady: async () => {},
			whenIdle: async () => {},
			checkNow: async () => {
				throw new Error("boom");
			},
			status: () => {
				throw new Error("boom");
			},
			envelope: () => {
				throw new Error("boom");
			},
		});
		for (const url of ["/api/v1/health", "/api/v1/health?manifest=1"]) {
			const res = await healthApp.request(url);
			const body = await res.json();
			expect({ url, status: res.status, health: body.status }).toEqual({
				url,
				status: 200,
				health: "ok",
			});
			expect(body.update).toEqual({
				current: pkgVersion,
				latest: null,
				state: "unverified",
				stale: false,
				checkedAt: null,
			});
		}
	});

	test("clients keeps its 16-hex keys and gains nothing", async () => {
		checker();
		const body = await (await healthApp.request("/api/v1/health")).json();
		expect(Object.keys(body.clients).sort()).toEqual(["relay", "statusline"]);
		for (const value of Object.values(body.clients)) expect(value).toMatch(/^[0-9a-f]{16}$/);
	});

	test("without ?manifest=1 there is no releaseManifest key", async () => {
		checker();
		const body = await (await healthApp.request("/api/v1/health")).json();
		expect("releaseManifest" in body).toBe(false);
	});

	test("?manifest=1 returns the stored envelope as served, or null", async () => {
		const { c, source } = checker();
		const none = await (await healthApp.request("/api/v1/health?manifest=1")).json();
		expect(none.releaseManifest).toBeNull();
		const text = envelopeFor(testPayload());
		source.push(text);
		await c.checkNow();
		const some = await (await healthApp.request("/api/v1/health?manifest=1")).json();
		expect(some.releaseManifest).toBe(text);
	});

	test("?manifest=1 carries no second copy of anything the checker holds beyond the envelope", async () => {
		const { c, source } = checker();
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
		const body = await (await healthApp.request("/api/v1/health?manifest=1")).json();
		expect(typeof body.releaseManifest).toBe("string");
		expect(Object.keys(body).filter((k) => /manifest/i.test(k))).toEqual(["releaseManifest"]);
	});
});

describe("GET /capabilities", () => {
	const get = (key = observeKey) =>
		app.request("/api/v1/capabilities", { headers: { Authorization: `Bearer ${key}` } });

	test("carries the full UpdateStatus and advertises updateStatus", async () => {
		const { c, source } = checker();
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
		const body = await (await get(manageKey)).json();
		expect(body.features.updateStatus).toBe(true);
		expect(body.update).toMatchObject({
			current: "0.11.0",
			latest: "0.12.0",
			state: "available",
			stale: false,
			severity: "normal",
			installKind: "container",
			track: null,
			localApply: null,
			lastResult: "ok",
			manifestIssuedAt: "2026-11-19T11:00:00.000Z",
		});
		expect(typeof body.update.checkedAt).toBe("string");
	});

	test("the state is a known name for every state the checker can be in", async () => {
		for (const [state, current, over] of STATES) {
			const { c, source } = checker(undefined, { currentVersion: current });
			source.push(envelopeFor(testPayload(over)));
			await c.checkNow();
			const body = await (await get()).json();
			expect({ state, ok: isKnownUpdateState(body.update.state), got: body.update.state }).toEqual({
				state,
				ok: true,
				got: state,
			});
		}
	});

	test("an observe key gets only the public fields; a manage key gets everything", async () => {
		const { c, source } = checker();
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
		const limited = (await (await get()).json()).update;
		expect(Object.keys(limited).sort()).toEqual(
			["checkedAt", "current", "latest", "severity", "stale", "state"].sort(),
		);
		const full = (
			await (
				await app.request("/api/v1/capabilities", {
					headers: { Authorization: `Bearer ${manageKey}` },
				})
			).json()
		).update;
		for (const key of ["installKind", "track", "lastResult", "localApply", "manifestIssuedAt"]) {
			expect(key in full).toBe(true);
		}
	});

	test("it carries no URL, command or path of the manifest, only versions and flags", async () => {
		const { c, source } = checker();
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
		const text = JSON.stringify((await (await get()).json()).update);
		expect(text).not.toMatch(/https?:|docker|git |\/Users\//);
	});
});

describe("localApply is for an admin only", () => {
	const APPLY = {
		auto: true,
		lastOutcome: "supervisor_busy" as const,
		lastTarget: "0.12.0",
		at: "2026-11-19T10:00:00.000Z",
		waitingSince: "2026-11-19T04:00:00.000Z",
	};
	const localChecker = async () => {
		const { c, source } = checker(undefined, {
			install: () => ({ kind: "local", track: "release" }),
			localApply: () => APPLY,
		});
		source.push(envelopeFor(testPayload()));
		await c.checkNow();
	};
	const read = async (key: string) =>
		(
			await (
				await app.request("/api/v1/capabilities", { headers: { Authorization: `Bearer ${key}` } })
			).json()
		).update as Record<string, unknown>;
	afterEach(async () => {
		await clearInstanceSettings();
	});

	test("solo: an ownerless manage key is an admin and reads it; an observe key gets the six public fields", async () => {
		await localChecker();
		expect((await read(manageKey)).localApply).toEqual(APPLY);
		const observe = await read(observeKey);
		expect("localApply" in observe).toBe(false);
		expect(Object.keys(observe)).toHaveLength(6);
	});

	test("team mode: a member's manage key reads the operator fields but has no localApply key at all", async () => {
		await localChecker();
		await setStoredMode("team");
		const member = await seedLocalUser("la-member");
		const memberKey = await seedKey("la-member-manage", ["manage"], member.id);
		const body = await read(memberKey.key);
		expect("localApply" in body).toBe(false);
		expect(body.installKind).toBe("local");
		expect(JSON.stringify(body)).not.toContain("supervisor_busy");
		// control: an admin's key, same server state, same request, gets it
		const admin = await seedLocalUser("la-admin", "admin");
		const adminKey = await seedKey("la-admin-manage", ["manage"], admin.id);
		expect((await read(adminKey.key)).localApply).toEqual(APPLY);
	});

	test("team mode: an ownerless manage key that isn't a kept admin service key doesn't see it", async () => {
		await localChecker();
		await setStoredMode("team");
		const loose = await seedKey("la-loose-manage", ["manage"], null);
		expect("localApply" in (await read(loose.key))).toBe(false);
	});

	test("/health never carries it, to anyone", async () => {
		await localChecker();
		const body = await (await healthApp.request("/api/v1/health?manifest=1")).json();
		expect(JSON.stringify(body)).not.toContain("localApply");
		expect(JSON.stringify(body)).not.toContain("supervisor_busy");
	});

	test("the check-now route answers admins only, so its body is never a member's", async () => {
		await localChecker();
		await setStoredMode("team");
		const member = await seedLocalUser("la-member2");
		const memberKey = await seedKey("la-member2-manage", ["manage"], member.id);
		const res = await app.request("/api/v1/update/check", {
			method: "POST",
			headers: { Authorization: `Bearer ${memberKey.key}` },
		});
		expect(res.status).toBe(403);
		expect(JSON.stringify(await res.json())).not.toContain("localApply");
	});
});
