/**
 * Limit on new sessions per minute, in TEAM mode only (solo is unlimited, as
 * before). Keyed by the posting key's owner when it has one, so one person's
 * several keys share an allowance, else by the key. Generous by default (120),
 * tunable with AGENTPULSE_SESSION_CREATE_LIMIT, applied only to session
 * CREATIONS: events for sessions that already exist are never limited, and
 * over-limit creations are dropped with a 200, counted on /health and logged
 * once per window.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { processHookEvent } = await import("./event-processor.js");
const {
	_resetSessionCreationLimitForTest,
	_setSessionCreationClockForTest,
	_trackedCreationWindowsForTest,
	getSessionCreationLimit,
	noteOverLimitOnce,
	sessionCreationLimitSubject,
	tryConsumeSessionCreation,
} = await import("./session-creation-limit.js");
const { _resetCountersForTest, getSessionCreationLimitedCount, getInFlightCount } = await import(
	"../routes/ingest-counters.js"
);

const LIMIT_ENV = "AGENTPULSE_SESSION_CREATE_LIMIT";
const originalLimit = process.env[LIMIT_ENV];

// Other files read /health expecting the not-ready state a fresh process has.
afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

beforeAll(async () => {
	await initializeDatabase();
	// /health answers 503 until the database is marked ready.
	(await import("../routes/health.js")).markDbReady();
});

async function reset() {
	if (originalLimit === undefined) delete process.env[LIMIT_ENV];
	else process.env[LIMIT_ENV] = originalLimit;
	_setSessionCreationClockForTest(null);
	_resetSessionCreationLimitForTest();
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

function ctx(keyId: string, ownerUserId: string | null = null) {
	return {
		keyId,
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId, ingestKeyId: keyId },
	};
}
const start = (sessionId: string) => ({ session_id: sessionId, hook_event_name: "SessionStart" });
const exists = async (sessionId: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId))).length > 0;

describe("the limit", () => {
	test("defaults to 120 a minute, tunable by env, and falls back to the default on nonsense", () => {
		expect(getSessionCreationLimit()).toBe(120);
		process.env[LIMIT_ENV] = "5";
		expect(getSessionCreationLimit()).toBe(5);
		for (const bad of ["", "0", "-3", "many", "1.5"]) {
			process.env[LIMIT_ENV] = bad;
			expect({ bad, limit: getSessionCreationLimit() }).toEqual({ bad, limit: 120 });
		}
	});

	test("allows the limit within a minute, refuses the next, and a later minute starts fresh", () => {
		process.env[LIMIT_ENV] = "3";
		let now = 1_000_000;
		_setSessionCreationClockForTest(() => now);
		expect([1, 2, 3].map(() => tryConsumeSessionCreation("k"))).toEqual([true, true, true]);
		expect(tryConsumeSessionCreation("k")).toBe(false);
		now += 59_000;
		expect(tryConsumeSessionCreation("k")).toBe(false);
		now += 2_000;
		expect(tryConsumeSessionCreation("k")).toBe(true);
	});

	test("each key has its own allowance", () => {
		process.env[LIMIT_ENV] = "1";
		_setSessionCreationClockForTest(() => 5_000_000);
		expect(tryConsumeSessionCreation("a")).toBe(true);
		expect(tryConsumeSessionCreation("a")).toBe(false);
		expect(tryConsumeSessionCreation("b")).toBe(true);
	});
});

describe("the key the allowance is counted under", () => {
	test("the owner when the key has one, else the key, else nothing", () => {
		expect(sessionCreationLimitSubject({ ownerUserId: "u1", ingestKeyId: "k1" })).toBe(
			sessionCreationLimitSubject({ ownerUserId: "u1", ingestKeyId: "k2" }),
		);
		expect(sessionCreationLimitSubject({ ownerUserId: "u1", ingestKeyId: "k1" })).not.toBe(
			sessionCreationLimitSubject({ ownerUserId: "u2", ingestKeyId: "k1" }),
		);
		expect(sessionCreationLimitSubject({ ownerUserId: null, ingestKeyId: "k1" })).not.toBe(
			sessionCreationLimitSubject({ ownerUserId: null, ingestKeyId: "k2" }),
		);
		expect(sessionCreationLimitSubject({ ownerUserId: null, ingestKeyId: null })).toBeNull();
		// An owner id and a key id that happen to be equal don't share an allowance.
		expect(sessionCreationLimitSubject({ ownerUserId: "same", ingestKeyId: "x" })).not.toBe(
			sessionCreationLimitSubject({ ownerUserId: null, ingestKeyId: "same" }),
		);
	});
});

describe("expired windows", () => {
	test("are dropped on a schedule, not by a scan on every call", () => {
		process.env[LIMIT_ENV] = "5";
		let now = 1_000_000;
		_setSessionCreationClockForTest(() => now);
		for (let i = 0; i < 12_000; i++) tryConsumeSessionCreation(`stale-${i}`);
		expect(_trackedCreationWindowsForTest()).toBe(12_000);

		// Still inside the first minute: nothing has expired, nothing is scanned away.
		now += 30_000;
		tryConsumeSessionCreation("fresh");
		expect(_trackedCreationWindowsForTest()).toBe(12_001);

		// A minute on, the next call sweeps the expired entries (well below any size threshold's reach is not needed).
		now += 31_000;
		tryConsumeSessionCreation("fresh-2");
		expect(_trackedCreationWindowsForTest()).toBeLessThanOrEqual(2);
	});

	test("a few expired entries are dropped too, not only above a size threshold", () => {
		let now = 2_000_000;
		_setSessionCreationClockForTest(() => now);
		for (const k of ["a", "b", "c"]) tryConsumeSessionCreation(k);
		now += 61_000;
		tryConsumeSessionCreation("d");
		expect(_trackedCreationWindowsForTest()).toBe(1);
	});

	test("an over-limit key is noted once per window, and again in the next", () => {
		process.env[LIMIT_ENV] = "1";
		let now = 3_000_000;
		_setSessionCreationClockForTest(() => now);
		tryConsumeSessionCreation("k");
		tryConsumeSessionCreation("k");
		expect([noteOverLimitOnce("k"), noteOverLimitOnce("k"), noteOverLimitOnce("k")]).toEqual([
			true,
			false,
			false,
		]);
		now += 61_000;
		tryConsumeSessionCreation("k");
		tryConsumeSessionCreation("k");
		expect(noteOverLimitOnce("k")).toBe(true);
	});
});

describe("on hook ingest", () => {
	test("sessions over a key's limit are dropped and counted; the key's other sessions and other keys are unaffected", async () => {
		await setStoredMode("team");
		process.env[LIMIT_ENV] = "2";
		_setSessionCreationClockForTest(() => 9_000_000);
		const a = await seedKey("scl-a", ["ingest"]);
		const b = await seedKey("scl-b", ["ingest"]);

		const results = [];
		for (const id of ["scl-1", "scl-2", "scl-3", "scl-4"]) {
			results.push(await processHookEvent(start(id), "claude_code", ctx(a.id)));
		}
		expect(results.map((r) => r.session !== null)).toEqual([true, true, false, false]);
		expect(await exists("scl-3")).toBe(false);
		expect(getSessionCreationLimitedCount()).toBe(2);

		// Events for sessions that exist are never limited.
		for (let i = 0; i < 5; i++) {
			const result = await processHookEvent(
				{ session_id: "scl-1", hook_event_name: "PostToolUse" },
				"claude_code",
				ctx(a.id),
			);
			expect(result.session).not.toBeNull();
		}
		// Another key still creates.
		expect(
			(await processHookEvent(start("scl-b-1"), "claude_code", ctx(b.id))).session,
		).not.toBeNull();
	});

	test("one owner's keys share an allowance; another owner's keys don't", async () => {
		await setStoredMode("team");
		process.env[LIMIT_ENV] = "2";
		_setSessionCreationClockForTest(() => 9_500_000);
		const alice = await seedLocalUser("scl-alice");
		const bob = await seedLocalUser("scl-bob");
		const a1 = await seedKey("scl-a1", ["ingest"], alice.id);
		const a2 = await seedKey("scl-a2", ["ingest"], alice.id);
		const b1 = await seedKey("scl-b1", ["ingest"], bob.id);

		expect(
			(await processHookEvent(start("o-1"), "claude_code", ctx(a1.id, alice.id))).session,
		).not.toBeNull();
		expect(
			(await processHookEvent(start("o-2"), "claude_code", ctx(a2.id, alice.id))).session,
		).not.toBeNull();
		expect(
			(await processHookEvent(start("o-3"), "claude_code", ctx(a1.id, alice.id))).session,
		).toBeNull();
		expect(
			(await processHookEvent(start("o-4"), "claude_code", ctx(a2.id, alice.id))).session,
		).toBeNull();
		expect(
			(await processHookEvent(start("o-5"), "claude_code", ctx(b1.id, bob.id))).session,
		).not.toBeNull();
	});

	test("the over-limit log line is written once per window", async () => {
		await setStoredMode("team");
		process.env[LIMIT_ENV] = "1";
		_setSessionCreationClockForTest(() => 9_700_000);
		const key = await seedKey("scl-log", ["ingest"]);
		const lines: string[] = [];
		const original = console.warn;
		console.warn = (line: unknown) => {
			lines.push(String(line));
		};
		try {
			for (const id of ["l-1", "l-2", "l-3", "l-4"]) {
				await processHookEvent(start(id), "claude_code", ctx(key.id));
			}
		} finally {
			console.warn = original;
		}
		expect(lines.filter((l) => l.includes("session_creation_limited")).length).toBe(1);
		expect(getSessionCreationLimitedCount()).toBe(3);
	});

	test("solo is unlimited: nothing is dropped, nothing is counted", async () => {
		process.env[LIMIT_ENV] = "1";
		_setSessionCreationClockForTest(() => 9_800_000);
		const key = await seedKey("scl-solo", ["ingest"]);
		for (const id of ["solo-1", "solo-2", "solo-3"]) {
			expect(
				(await processHookEvent(start(id), "claude_code", ctx(key.id))).session,
			).not.toBeNull();
		}
		expect(getSessionCreationLimitedCount()).toBe(0);
	});

	test("a delivery with no real key (DISABLE_AUTH, internal callers) is not limited", async () => {
		await setStoredMode("team");
		process.env[LIMIT_ENV] = "1";
		for (const id of ["scl-anon-1", "scl-anon-2", "scl-anon-3"]) {
			expect((await processHookEvent(start(id), "claude_code")).session).not.toBeNull();
		}
		expect(getSessionCreationLimitedCount()).toBe(0);
	});

	test("on the real route an over-limit creation is still a 200, and /health counts it", async () => {
		await setStoredMode("team");
		process.env[LIMIT_ENV] = "1";
		_setSessionCreationClockForTest(() => 11_000_000);
		const key = await seedKey("scl-route", ["ingest"]);
		for (const id of ["scl-route-1", "scl-route-2"]) {
			const res = await app.request(
				"/api/v1/hooks",
				jsonRequest("POST", start(id), bearerHeaders(key.key)),
			);
			expect(res.status).toBe(200);
		}
		for (let i = 0; i < 200 && getInFlightCount() > 0; i++)
			await new Promise((r) => setTimeout(r, 10));
		expect(await exists("scl-route-1")).toBe(true);
		expect(await exists("scl-route-2")).toBe(false);
		const health = (await (await app.request("/api/v1/health")).json()) as {
			sessionCreationLimited?: number;
		};
		expect(health.sessionCreationLimited).toBe(1);
	});
});
