/**
 * Past the candidate cap the poll must still see every row that can need
 * attention, however much newer idle noise there is and wherever the database
 * happens to return rows from. The scan is an attention-tier query (failed,
 * a finished turn nobody has acknowledged, an agent-reported wait, a
 * permission wait) plus an unsorted fill up to the cap, and says it truncated.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { ACTIVE_OPERATIONAL_STATUSES, getOperationalStatus } from "../../shared/session-state.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getSessions, getStats, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { insertAll, prng, randomRow } = await import("../test-utils/random-sessions.js");

const HEAVY_MS = 60_000;

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
// Deleting thousands of sessions runs the full-text triggers per row (seconds),
// so the heavy tests clean up after themselves under their own generous limit
// instead of leaving it to the next test's setup.
afterEach(async () => {
	_setOperationalCandidateCapForTest(null);
	await getDb().delete(sessions).execute();
}, HEAVY_MS);

const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

async function insertIdle(count: number, prefix = "idle") {
	for (let from = 0; from < count; from += 200) {
		const rows = Array.from({ length: Math.min(200, count - from) }, (_, i) => ({
			sessionId: `${prefix}-${from + i}`,
			displayName: `${prefix}-${from + i}`,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			lastActivityAt: iso((from + i) * 10),
		}));
		await getDb().insert(sessions).values(rows).execute();
	}
}

async function insertOne(sessionId: string, overrides: Record<string, unknown>) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			lastActivityAt: iso(10 * HOUR),
			...overrides,
		} as never)
		.execute();
}

describe("old attention rows inserted after the noise are still counted", () => {
	test(
		"at the default cap: thousands of fresh idle rows, then an old waiting row and an old failure",
		async () => {
			await insertIdle(5100);
			await insertOne("old-waiting", { lastAgentTurnCompletedAt: iso(10 * HOUR) });
			await insertOne("old-failed", { status: "failed", endedAt: iso(10 * HOUR) });

			const stats = await getStats();
			expect(stats.truncated).toBe(true);
			expect(stats.operational.waiting).toBe(1);
			expect(stats.operational.error).toBe(1);

			const waiting = await getSessions({ operational: "waiting" });
			expect(waiting.sessions.map((s) => s.sessionId)).toEqual(["old-waiting"]);
			const failed = await getSessions({ operational: "error" });
			expect(failed.sessions.map((s) => s.sessionId)).toEqual(["old-failed"]);
		},
		HEAVY_MS,
	);

	test("an old agent-reported wait with no permission metadata", async () => {
		_setOperationalCandidateCapForTest(3);
		await insertIdle(8);
		await insertOne("old-semantic-wait", { semanticStatus: "waiting" });
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(1);
	});

	test("an old finished turn whose acknowledgement is in a format SQL can't compare", async () => {
		_setOperationalCandidateCapForTest(3);
		const turn = new Date(Date.now() - 10 * HOUR);
		const earlier = new Date(turn.getTime() - HOUR).toISOString().slice(0, 19).replace("T", " ");
		await insertIdle(8);
		await insertOne("old-undecidable", {
			lastAgentTurnCompletedAt: turn.toISOString(),
			lastUserAcknowledgedAt: earlier,
		});
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(1);
	});

	test("an old permission wait", async () => {
		_setOperationalCandidateCapForTest(3);
		await insertIdle(8);
		await insertOne("old-permission", {
			isWorking: true,
			metadata: { permissionWait: { ids: ["t1"], anon: 0 } },
		});
		const stats = await getStats();
		expect(stats.operational.waiting).toBe(1);
	});
});

describe("the fill and the cap", () => {
	test("what the attention tier doesn't use of the cap is filled with other rows", async () => {
		_setOperationalCandidateCapForTest(10);
		await insertIdle(20);
		for (let i = 0; i < 3; i++) {
			await insertOne(`att-${i}`, { lastAgentTurnCompletedAt: iso(10 * HOUR) });
		}
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(3);
		expect(stats.operational.idle).toBe(7);
	});

	test("an attention tier larger than the cap is capped and reported truncated, newest first", async () => {
		_setOperationalCandidateCapForTest(3);
		for (let i = 0; i < 6; i++) {
			await insertOne(`att-${i}`, {
				lastAgentTurnCompletedAt: iso(10 * HOUR),
				lastActivityAt: iso((i + 1) * HOUR),
			});
		}
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(3);
		const page = await getSessions({ operational: "waiting" });
		expect(page.sessions.map((s) => s.sessionId)).toEqual(["att-0", "att-1", "att-2"]);
	});

	test("under the cap nothing changes: one scan", async () => {
		_setOperationalCandidateCapForTest(50);
		await insertIdle(5);
		const calls = await countDbCalls(async () => {
			await getStats();
		});
		expect(calls).toBe(2);
	});

	test("past the cap the poll is the aggregate, the probe, the attention tier and the fill", async () => {
		_setOperationalCandidateCapForTest(5);
		await insertIdle(12);
		const calls = await countDbCalls(async () => {
			await getStats();
		});
		expect(calls).toBe(4);
	});
});

describe("the attention tier is a superset of everything the classifier calls waiting or error", () => {
	test(
		"3000 randomised rows among 4000 clean ones, cap between the two: waiting and error are exact",
		async () => {
			const rand = prng(77);
			await insertAll(Array.from({ length: 3000 }, (_, i) => randomRow(rand, i)));
			await insertIdle(4000, "clean");

			const fullRows = await getDb().select().from(sessions);
			const expected = { waiting: 0, error: 0 };
			let live = 0;
			for (const row of fullRows) {
				const status = getOperationalStatus(row);
				if (status === "waiting" || status === "error") expected[status] += 1;
				if (status !== "completed") live += 1;
			}
			expect(expected.waiting).toBeGreaterThan(100);
			expect(expected.error).toBeGreaterThan(50);

			// Room for every row that can need attention, not for every row.
			_setOperationalCandidateCapForTest(live - 500);
			const stats = await getStats();
			expect(stats.truncated).toBe(true);
			expect({ waiting: stats.operational.waiting, error: stats.operational.error }).toEqual(
				expected,
			);
			for (const status of ACTIVE_OPERATIONAL_STATUSES) {
				expect(stats.operational[status]).toBeGreaterThan(0);
			}
		},
		HEAVY_MS,
	);
});

describe("an attention tier larger than the cap keeps failures first", () => {
	test("cap 5: three old failures survive four newer agent-reported waits", async () => {
		_setOperationalCandidateCapForTest(5);
		for (let i = 0; i < 3; i++) {
			await insertOne(`failed-${i}`, {
				status: "failed",
				endedAt: iso(20 * HOUR),
				lastActivityAt: iso((20 + i) * HOUR),
			});
		}
		for (let i = 0; i < 4; i++) {
			await insertOne(`reported-${i}`, {
				semanticStatus: "waiting",
				lastActivityAt: iso(i * HOUR),
			});
		}
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.error).toBe(3);
		expect(stats.operational.waiting).toBe(2);
	});

	test(
		"3,000 old failures and 3,000 newer waits at the default cap: every failure is kept",
		async () => {
			const old = Array.from({ length: 3000 }, (_, i) => ({
				sessionId: `failed-${i}`,
				displayName: `failed-${i}`,
				agentType: "claude_code",
				status: "failed",
				endedAt: iso(30 * HOUR),
				metadata: {},
				lastActivityAt: iso(30 * HOUR + i),
			}));
			const fresh = Array.from({ length: 3000 }, (_, i) => ({
				sessionId: `reported-${i}`,
				displayName: `reported-${i}`,
				agentType: "claude_code",
				status: "active",
				semanticStatus: "waiting",
				metadata: {},
				lastActivityAt: iso(i),
			}));
			await insertAll([...old, ...fresh]);
			const stats = await getStats();
			expect(stats.truncated).toBe(true);
			expect(stats.operational.error).toBe(3000);
			expect(stats.operational.waiting).toBe(2000);
		},
		HEAVY_MS,
	);
});

describe("the acknowledgement guard in the attention tier", () => {
	test("a turn that finished as a bare timestamp, acknowledged earlier the same day in the ISO form, is still waiting past the cap", async () => {
		_setOperationalCandidateCapForTest(3);
		await insertIdle(8);
		// The same calendar day, 11:00 against 10:00: as text the ISO form sorts
		// after the bare one ('T' is above ' '), so a plain text comparison would
		// call the 10:00 acknowledgement newer than the 11:00 turn.
		const day = iso(48 * HOUR).slice(0, 10);
		await insertOne("old-mixed", {
			lastActivityAt: iso(48 * HOUR),
			lastAgentTurnCompletedAt: `${day} 11:00:00`,
			lastUserAcknowledgedAt: `${day}T10:00:00.000Z`,
		});
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(1);
	});

	test("an acknowledgement written with an offset, later as text but earlier in time than the ISO turn, is still waiting past the cap", async () => {
		_setOperationalCandidateCapForTest(3);
		await insertIdle(8);
		// 09:00 at +02:00 is 07:00 UTC, before the 08:00 UTC turn, though as text
		// "09:00:00+02:00" sorts after "08:00:00.000Z".
		const day = iso(48 * HOUR).slice(0, 10);
		await insertOne("old-offset", {
			lastActivityAt: iso(48 * HOUR),
			lastAgentTurnCompletedAt: `${day}T08:00:00.000Z`,
			lastUserAcknowledgedAt: `${day}T09:00:00+02:00`,
		});
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(1);
	});

	test("positive control: the same pair, both in the ISO form and acknowledged after the turn, is not waiting", async () => {
		_setOperationalCandidateCapForTest(3);
		await insertIdle(8);
		const day = iso(48 * HOUR).slice(0, 10);
		await insertOne("old-acked", {
			lastActivityAt: iso(48 * HOUR),
			lastAgentTurnCompletedAt: `${day}T10:00:00.000Z`,
			lastUserAcknowledgedAt: `${day}T11:00:00.000Z`,
		});
		const stats = await getStats();
		expect(stats.operational.waiting).toBe(0);
	});
});
