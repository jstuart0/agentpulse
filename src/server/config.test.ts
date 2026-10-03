// AGEN-24 percy review, item 6: AGENTPULSE_RETENTION_INTERVAL_MS must be
// clamped like the AGENTPULSE_PG_POOL_MAX pattern in db/client.ts (invalid
// or out-of-range values fall back to a safe default with a warning, rather
// than an absurdly short interval hammering the DB or an absurdly long one
// that never enforces retention).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { config } = await import("./config.js");

const ENV_KEY = "AGENTPULSE_RETENTION_INTERVAL_MS";
const originalEnv = process.env[ENV_KEY];

// Mirrors the established forwardauthTrustSecret test-reset pattern
// (config.ts memoizes on the object itself; `configurable: true` allows
// deleting the cache).
function resetMemo() {
	// biome-ignore lint/performance/noDelete: clear memoised interval so env var takes effect
	delete (config as Record<string, unknown>)._retentionIntervalMs;
}

beforeEach(() => {
	resetMemo();
});

afterEach(() => {
	if (originalEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalEnv;
	resetMemo();
});

describe("config.retentionIntervalMs", () => {
	test("defaults to 1 hour when unset", () => {
		delete process.env[ENV_KEY];
		expect(config.retentionIntervalMs).toBe(60 * 60 * 1000);
	});

	test("passes through a valid custom value", () => {
		process.env[ENV_KEY] = String(15 * 60 * 1000);
		expect(config.retentionIntervalMs).toBe(15 * 60 * 1000);
	});

	// Matches the AGENTPULSE_PG_POOL_MAX pattern in db/client.ts: an
	// out-of-range value does not get snapped to the nearest boundary — it's
	// rejected wholesale and falls back to the default, with a warning.
	test("rejects a value below the 60s floor, falling back to the default", () => {
		process.env[ENV_KEY] = "1000";
		expect(config.retentionIntervalMs).toBe(60 * 60 * 1000);
	});

	test("rejects a value above the 24h ceiling, falling back to the default", () => {
		process.env[ENV_KEY] = String(999 * 60 * 60 * 1000);
		expect(config.retentionIntervalMs).toBe(60 * 60 * 1000);
	});

	test("accepts the 60s floor value exactly", () => {
		process.env[ENV_KEY] = "60000";
		expect(config.retentionIntervalMs).toBe(60_000);
	});

	test("accepts the 24h ceiling value exactly", () => {
		process.env[ENV_KEY] = String(24 * 60 * 60 * 1000);
		expect(config.retentionIntervalMs).toBe(24 * 60 * 60 * 1000);
	});

	test("clamps a non-numeric value to the default", () => {
		process.env[ENV_KEY] = "not-a-number";
		expect(config.retentionIntervalMs).toBe(60 * 60 * 1000);
	});

	test("clamps a negative value to the default", () => {
		process.env[ENV_KEY] = "-5000";
		expect(config.retentionIntervalMs).toBe(60 * 60 * 1000);
	});
});

describe("config.modeEnv / config.modeEnvRaw", () => {
	const MODE_KEY = "AGENTPULSE_MODE";
	const originalMode = process.env[MODE_KEY];

	afterEach(() => {
		if (originalMode === undefined) delete process.env[MODE_KEY];
		else process.env[MODE_KEY] = originalMode;
	});

	test("unset or blank is no value at all", () => {
		delete process.env[MODE_KEY];
		expect(config.modeEnv).toBeNull();
		expect(config.modeEnvRaw).toBeNull();
		process.env[MODE_KEY] = "   ";
		expect(config.modeEnv).toBeNull();
		expect(config.modeEnvRaw).toBeNull();
	});

	test("solo and team are recognised after trimming and ignoring case", () => {
		for (const [raw, expected] of [
			["solo", "solo"],
			["team", "team"],
			["  TEAM ", "team"],
			["Solo", "solo"],
		] as const) {
			process.env[MODE_KEY] = raw;
			expect(config.modeEnv).toBe(expected);
			expect(config.modeEnvRaw).toBe(raw.trim());
		}
	});

	test("anything else is set-but-unrecognised: no mode, but the raw value is visible so boot can refuse it", () => {
		process.env[MODE_KEY] = " teem ";
		expect(config.modeEnv).toBeNull();
		expect(config.modeEnvRaw).toBe("teem");
	});
});

describe("config.adminSsoSubjects", () => {
	const SUBJECTS_KEY = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
	const originalSubjects = process.env[SUBJECTS_KEY];

	afterEach(() => {
		if (originalSubjects === undefined) delete process.env[SUBJECTS_KEY];
		else process.env[SUBJECTS_KEY] = originalSubjects;
	});

	test("unset or blank is an empty list", () => {
		delete process.env[SUBJECTS_KEY];
		expect(config.adminSsoSubjects).toEqual([]);
		process.env[SUBJECTS_KEY] = " , ,";
		expect(config.adminSsoSubjects).toEqual([]);
	});

	test("splits on commas, trims entries and drops empty ones, keeping case and order", () => {
		process.env[SUBJECTS_KEY] = " Uid-A, uid-b ,,UID-c ";
		expect(config.adminSsoSubjects).toEqual(["Uid-A", "uid-b", "UID-c"]);
	});

	test("is read at call time, so a changed env is seen without re-importing", () => {
		process.env[SUBJECTS_KEY] = "one";
		expect(config.adminSsoSubjects).toEqual(["one"]);
		process.env[SUBJECTS_KEY] = "two";
		expect(config.adminSsoSubjects).toEqual(["two"]);
	});
});
