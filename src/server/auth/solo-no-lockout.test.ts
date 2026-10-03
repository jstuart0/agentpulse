/**
 * Solo installs don't change. Every API route that existed before team mode,
 * called as each kind of caller a single-operator install has (a local admin, a
 * local user, an SSO member, an ownerless manage key, and with auth disabled),
 * answers with exactly the status it answered with then, against rows the
 * owner-or-admin checks would have judged. The "then" is base-route-statuses.ts,
 * recorded by running the same probe on the main branch before this work.
 *
 * The upgrade case seeds the shape of a real pre-team install (one admin, one
 * member, three ownerless manage keys, none of the new environment variables)
 * and runs the same comparison against it, as the one mode a fresh install and
 * an upgrade both start in: solo.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { clearInstanceSettings, seedKey } from "../test-utils/team-fixtures.js";

const { initializeDatabase } = await import("../db/client.js");
const { _resetDbReadyForTest } = await import("../routes/health.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { app } = await import("../app.js");
const { config } = await import("../config.js");
const { getMode } = await import("../services/instance-mode.js");
const { BASE_ROUTE_STATUSES } = await import("./base-route-statuses.js");
const { PROBE_CALLERS, probeRoutes, probeStatuses, seedProbeIdentities } = await import(
	"../test-utils/base-route-probe.js"
);

const MODE_ENV = "AGENTPULSE_MODE";
const originalModeEnv = process.env[MODE_ENV];
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	// GET /health answers 503 until the database is marked ready; the recorded
	// table is the starting state, whatever another file left behind.
	_resetDbReadyForTest(false);
	// The AI routes answer 409 while AI is off at runtime, the starting state.
	await upsertSetting("ai.enabled", false, { allowProtected: true });
	await upsertSetting("ai.killSwitch", false, { allowProtected: true });
	if (originalModeEnv === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = originalModeEnv;
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const BASE_ROUTES = BASE_ROUTE_STATUSES.map(([route]) => route);

describe("the recorded table", () => {
	test("covers the routes that existed before, with a floor and named members", () => {
		expect(BASE_ROUTES.length).toBeGreaterThanOrEqual(129);
		for (const named of [
			"GET /sessions",
			"PUT /settings",
			"POST /api-keys",
			"DELETE /api-keys/:id",
			"POST /admin/supervisors/:id/rotate",
			"POST /admin/supervisors/:id/revoke",
			"PUT /settings/workspace",
			"POST /projects/:id/cleanup-workarea",
			"PUT /labs/flags/:flag",
			"POST /hooks",
			"POST /sessions/:sessionId/acknowledge",
			"DELETE /sessions/:sessionId/acknowledge",
			"PUT /sessions/:sessionId/archive",
			"PUT /sessions/:sessionId/rename",
			"PUT /sessions/:sessionId/pin",
			"DELETE /sessions/:sessionId",
		]) {
			expect({ named, listed: BASE_ROUTES.includes(named) }).toEqual({ named, listed: true });
		}
	});

	test("every one of those routes is still registered, and the app has only added to them", () => {
		const current = new Set(probeRoutes(app.routes));
		const missing = BASE_ROUTES.filter((route) => !current.has(route));
		expect(missing).toEqual([]);
		expect(current.size).toBeGreaterThan(BASE_ROUTES.length);
	});
});

describe("solo: every route that existed before answers with exactly the same status", () => {
	test("for a local admin, a local user, an SSO member, an ownerless manage key and DISABLE_AUTH", async () => {
		const ids = await seedProbeIdentities();
		const statuses = await probeStatuses(app, BASE_ROUTES, ids);
		const mismatches: string[] = [];
		for (const [route, expected] of BASE_ROUTE_STATUSES) {
			PROBE_CALLERS.forEach((caller, i) => {
				const got = statuses[route]?.[caller];
				if (got !== expected[i]) {
					mismatches.push(`${route} as ${caller}: ${expected[i]} before, ${got} now`);
				}
			});
		}
		expect(mismatches).toEqual([]);
	}, 120_000);
});

describe("upgrade: a pre-team install (one admin, one user, three ownerless manage keys, no new env)", () => {
	test("is solo, and every base route answers exactly as it did for each of those callers", async () => {
		delete process.env[MODE_ENV];
		const ids = await seedProbeIdentities();
		const extraKeys = [
			await seedKey("up-manage-second", ["manage"]),
			await seedKey("up-manage-third", ["manage"]),
		];
		expect(await getMode()).toBe("solo");
		expect(config.modeEnv).toBeNull();

		const keys = [ids.manageKey, ...extraKeys.map((k) => k.key)];
		expect(keys.length).toBe(3);
		const mismatches: string[] = [];
		for (const key of keys) {
			const statuses = await probeStatuses(app, BASE_ROUTES, { ...ids, manageKey: key }, [
				"localAdmin",
				"localUser",
				"ownerlessManageKey",
			]);
			for (const [route, expected] of BASE_ROUTE_STATUSES) {
				for (const caller of ["localAdmin", "localUser", "ownerlessManageKey"] as const) {
					const want = expected[PROBE_CALLERS.indexOf(caller)];
					const got = statuses[route]?.[caller];
					if (got !== want) {
						mismatches.push(`${route} as ${caller}: ${want} before, ${got} now`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	}, 180_000);
});
