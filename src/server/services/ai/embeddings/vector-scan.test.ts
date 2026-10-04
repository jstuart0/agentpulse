/**
 * The bounded, paced vector scan: budgets, pacing arithmetic on an injected
 * clock, ranking parity with a plain-loop oracle, and failure modes. Runs on
 * the Drizzle-migrated SQLite shape; the legacy-init shape and the stale
 * suffix / orphan / mixed-model cases run in `vector-scan.shapes.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { describeSqliteOnly } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const scan = await import("./vector-scan.js");
const { bufferToVector, cosineSimilarity } = await import("./types.js");
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");
const { createFakeClock, runWithClock } = await import("../../../test-utils/fake-clock.js");
const {
	clearEmbeddingFixtures,
	ensureSessions,
	makeRng,
	mixedVector,
	randomUnitVector,
	readAllEmbeddingRows,
	seedRows,
} = await import("../../../test-utils/embedding-fixtures.js");

import type { StatementMeter } from "../../../test-utils/statement-meter.js";

const MODEL = "scan-test-4096";
const DIM = 4096;
/** Statements that read vectors from the table (not the oracle's unbounded read). */
const CHUNK_SQL = /FROM event_embeddings v[\s\S]*LIMIT/;
const FLOOR = 0.4;
const INDEX = "idx_event_embeddings_model_dim_event";

const scanConfig = config as unknown as Record<string, number>;
const originalScanConfig = {
	vectorScanMaxRows: scanConfig.vectorScanMaxRows,
	vectorScanMaxMs: scanConfig.vectorScanMaxMs,
	vectorScanCpuShare: scanConfig.vectorScanCpuShare,
};

let meter: StatementMeter;

function setBudgets(opts: { maxRows?: number; maxMs?: number; share?: number }) {
	if (opts.maxRows !== undefined) scanConfig.vectorScanMaxRows = opts.maxRows;
	if (opts.maxMs !== undefined) scanConfig.vectorScanMaxMs = opts.maxMs;
	if (opts.share !== undefined) scanConfig.vectorScanCpuShare = opts.share;
}

/** `count` rows, ids 1..count, cosine to `query` spread over (0, 1) so the floor splits them. */
function seedMixed(count: number, dim: number, query: Float32Array, seed = 11, model = MODEL) {
	const rng = makeRng(seed);
	const rows = [];
	for (let id = 1; id <= count; id++) {
		rows.push({
			id,
			sessionId: `s-${id % 9}`,
			model,
			dim,
			vector: mixedVector(rng, query, rng()),
		});
	}
	ensureSessions([...new Set(rows.map((r) => r.sessionId))]);
	seedRows(rows);
}

function seedPlain(count: number, dim: number, seed = 5, model = MODEL, startId = 1) {
	const rng = makeRng(seed);
	const rows = [];
	for (let i = 0; i < count; i++) {
		const id = startId + i;
		rows.push({ id, sessionId: `s-${id % 9}`, model, dim, vector: randomUnitVector(rng, dim) });
	}
	ensureSessions([...new Set(rows.map((r) => r.sessionId))]);
	seedRows(rows);
}

/** The ranking the old code produced: every row, plain loop, repo helpers. */
function oracle(query: Float32Array, model: string, dim: number) {
	const per = new Map<string, { max: number; count: number }>();
	for (const row of readAllEmbeddingRows(model, dim)) {
		const sim = cosineSimilarity(query, bufferToVector(row.vector as Buffer));
		if (sim < FLOOR) continue;
		const entry = per.get(row.sessionId) ?? { max: 0, count: 0 };
		if (sim > entry.max) entry.max = sim;
		entry.count += 1;
		per.set(row.sessionId, entry);
	}
	return per;
}

/** Fake clock whose chunk statements cost `chunkCostMs` of fake time. */
function useFakeClock(chunkCostMs: number, options: { autoAdvance?: boolean } = {}) {
	const clock = createFakeClock({ autoAdvance: options.autoAdvance ?? true });
	scan.__setVectorScanClockForTests({ now: clock.now, sleep: clock.sleep });
	meter.setAfterExecute((execution) => {
		if (CHUNK_SQL.test(execution.sql)) clock.advance(chunkCostMs);
	});
	return clock;
}

function captureLogs() {
	const lines: Array<Record<string, unknown>> = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		const first = args[0];
		if (typeof first !== "string") return;
		try {
			lines.push(JSON.parse(first));
		} catch {
			// not a structured line
		}
	});
	return { lines, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(() => {
	clearEmbeddingFixtures();
	scan.__resetVectorScanStateForTests();
	setBudgets({ maxRows: 50_000, maxMs: 60_000, share: 1 });
	meter = installStatementMeter();
});

afterEach(() => {
	meter.restore();
	scan.__resetVectorScanStateForTests();
	Object.assign(scanConfig, originalScanConfig);
	const sqlite = getSqlite();
	sqlite.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON event_embeddings (model, dim, event_id)`);
});

describeSqliteOnly("scan results match the old ranking", () => {
	test("per-session max and count equal a plain-loop oracle, with rows at every chunk boundary", async () => {
		const query = randomUnitVector(makeRng(1), DIM);
		seedMixed(1_200, DIM, query);

		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });

		const expected = oracle(query, MODEL, DIM);
		expect(expected.size).toBeGreaterThan(3);
		expect(result.perSession.size).toBe(expected.size);
		for (const [session, value] of expected) {
			expect(result.perSession.get(session)).toEqual(value);
		}
		expect(result.stats.returned).toBe(1_200);
		expect(result.stats.stopReason).toBe("exhausted");
	});

	test("keyset paging with gaps visits each live row exactly once", async () => {
		const query = randomUnitVector(makeRng(2), 16);
		const rows = [];
		for (let id = 1; id <= 1_500; id++) {
			if (id % 3 === 0) continue;
			rows.push({ id, sessionId: `own-${id}`, model: MODEL, dim: 16, vector: query });
		}
		for (let id = 101_500; id < 101_700; id++) {
			rows.push({ id, sessionId: `own-${id}`, model: MODEL, dim: 16, vector: query });
		}
		ensureSessions(rows.map((r) => r.sessionId));
		seedRows(rows);

		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 16 });

		expect(result.stats.returned).toBe(rows.length);
		expect(result.perSession.size).toBe(rows.length);
		for (const value of result.perSession.values()) expect(value.count).toBe(1);
		expect(result.stats.oldestEventId).toBe(1);
	});

	test("newest rows are covered first: a near-duplicate among the newest 100 is found under a 500-row budget, one among the oldest 100 is not", async () => {
		const query = randomUnitVector(makeRng(3), DIM);
		seedPlain(1_200, DIM, 7);
		ensureSessions(["newest-match", "oldest-match"]);
		seedRows([
			{ id: 1_150, sessionId: "newest-match", model: MODEL, dim: DIM, vector: query },
			{ id: 50, sessionId: "oldest-match", model: MODEL, dim: DIM, vector: query },
		]);

		setBudgets({ maxRows: 500 });
		const limited = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(limited.perSession.has("newest-match")).toBe(true);
		expect(limited.perSession.has("oldest-match")).toBe(false);

		setBudgets({ maxRows: 5_000 });
		const full = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(full.perSession.has("oldest-match")).toBe(true);
	});

	test("a cosine of exactly 0.4 is counted and one just below is not", async () => {
		// a = [1,0,0,0]; b = [2,4,2,1] has norm exactly 5, so cos = 2/5 = 0.4 in double arithmetic.
		const query = new Float32Array([1, 0, 0, 0]);
		ensureSessions(["at-floor", "below-floor"]);
		seedRows([
			{
				id: 1,
				sessionId: "at-floor",
				model: MODEL,
				dim: 4,
				vector: new Float32Array([2, 4, 2, 1]),
			},
			{
				id: 2,
				sessionId: "below-floor",
				model: MODEL,
				dim: 4,
				vector: new Float32Array([1.99, 4, 2, 1]),
			},
		]);

		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 4 });

		expect(cosineSimilarity(query, new Float32Array([2, 4, 2, 1]))).toBe(0.4);
		expect(result.perSession.get("at-floor")?.count).toBe(1);
		expect(result.perSession.has("below-floor")).toBe(false);
	});

	test("an all-zero stored vector scores 0 and is not counted; equal scores keep newest-first order", async () => {
		const query = randomUnitVector(makeRng(4), 8);
		ensureSessions(["zero", "older", "newer"]);
		seedRows([
			{ id: 1, sessionId: "older", model: MODEL, dim: 8, vector: query },
			{ id: 2, sessionId: "newer", model: MODEL, dim: 8, vector: query },
			{ id: 3, sessionId: "zero", model: MODEL, dim: 8, vector: new Float32Array(8) },
		]);

		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 });

		expect(result.perSession.has("zero")).toBe(false);
		expect([...result.perSession.keys()]).toEqual(["newer", "older"]);
		expect(result.stats.scored).toBe(3);
	});

	test("scanSessionSimilarity takes the query vector and { model, dim } and nothing else", () => {
		expect(scan.scanSessionSimilarity.length).toBe(2);
	});
});

describeSqliteOnly("row and time budgets", () => {
	test("a 500-row budget over 1,200 rows overshoots by less than one chunk and says so", async () => {
		seedPlain(1_200, DIM);
		setBudgets({ maxRows: 500 });
		const result = await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
			model: MODEL,
			dim: DIM,
		});
		expect(result.stats.returned).toBeGreaterThanOrEqual(500);
		expect(result.stats.returned).toBeLessThanOrEqual(516);
		expect(result.stats.truncated).toBe(true);
		expect(result.stats.stopReason).toBe("row_budget");
	});

	test("row budget boundaries: 16 is one statement, 17 is two, 1201 and 5000 exhaust a 1,200-row table", async () => {
		seedPlain(1_200, DIM);
		const query = randomUnitVector(makeRng(9), DIM);

		setBudgets({ maxRows: 16 });
		const one = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(one.stats.statements).toBe(1);
		expect(one.stats.returned).toBe(16);
		expect(one.stats.stopReason).toBe("row_budget");

		setBudgets({ maxRows: 17 });
		const two = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(two.stats.returned).toBeGreaterThanOrEqual(17);
		expect(two.stats.returned).toBeLessThanOrEqual(32);

		for (const maxRows of [1_201, 5_000]) {
			setBudgets({ maxRows });
			const all = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
			expect(all.stats.stopReason).toBe("exhausted");
			expect(all.stats.truncated).toBe(false);
			expect(all.stats.returned).toBe(1_200);
		}
	});

	test("a 4,000 ms budget with 10 ms chunks at a 0.3 share stops at the first chunk boundary at or after 4,000 fake ms", async () => {
		seedPlain(2_600, DIM);
		const clock = useFakeClock(10);
		setBudgets({ maxMs: 4_000, share: 0.3 });

		const result = await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
			model: MODEL,
			dim: DIM,
		});

		expect(result.stats.stopReason).toBe("time_budget");
		expect(result.stats.truncated).toBe(true);
		const chunkPlusSleep = 10 + 10 * (0.7 / 0.3);
		expect(result.stats.ms).toBeGreaterThanOrEqual(4_000);
		expect(result.stats.ms).toBeLessThan(4_000 + chunkPlusSleep);
		expect(clock.now()).toBeLessThan(4_000 + chunkPlusSleep);
	});

	test("a zero time budget on the real clock still runs exactly one chunk", async () => {
		seedPlain(200, DIM);
		setBudgets({ maxMs: 0 });
		const result = await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
			model: MODEL,
			dim: DIM,
		});
		expect(result.stats.statements).toBe(1);
		expect(result.stats.stopReason).toBe("time_budget");
	});

	test("stop reason precedence: exhausted over row budget over time budget", async () => {
		const query = randomUnitVector(makeRng(9), DIM);
		seedPlain(1_208, DIM); // 75 full chunks and a partial one of 8

		setBudgets({ maxRows: 1_208, maxMs: 60_000 });
		const exactFit = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(exactFit.stats.stopReason).toBe("exhausted");
		expect(exactFit.stats.truncated).toBe(false);

		setBudgets({ maxRows: 16, maxMs: 0 });
		const rowAndTime = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(rowAndTime.stats.stopReason).toBe("row_budget");

		setBudgets({ maxRows: 50_000, maxMs: 0 });
		const timeOnly = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(timeOnly.stats.stopReason).toBe("time_budget");

		clearEmbeddingFixtures();
		seedPlain(8, DIM);
		const shortTable = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(shortTable.stats.stopReason).toBe("exhausted");
	});

	test("budgets and share are read from config on every call", async () => {
		seedPlain(1_200, DIM);
		const query = randomUnitVector(makeRng(9), DIM);
		setBudgets({ maxRows: 100 });
		const first = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		setBudgets({ maxRows: 400 });
		const second = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(first.stats.returned).toBeLessThanOrEqual(112);
		expect(second.stats.returned).toBeGreaterThanOrEqual(400);

		setBudgets({ maxRows: 50_000, maxMs: 0 });
		const timed = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(timed.stats.stopReason).toBe("time_budget");
	});
});

describeSqliteOnly("pacing", () => {
	test("after each 10 ms chunk at a 0.3 share the scan sleeps about 23.3 ms, so slept time is 70% of the whole", async () => {
		seedPlain(800, DIM);
		const clock = useFakeClock(10);
		setBudgets({ share: 0.3 });

		const result = await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
			model: MODEL,
			dim: DIM,
		});

		expect(result.stats.statements).toBe(51); // 50 full chunks, then the empty one that proves the end
		for (const slept of clock.sleeps) expect(Math.abs(slept - 23.33)).toBeLessThan(0.5);
		const { busyMs, sleptMs } = result.stats;
		expect(Math.abs(sleptMs / (busyMs + sleptMs) - 0.7)).toBeLessThan(0.02);
	});

	test("chunks cheaper than 2 ms accumulate debt: no sleep under 2 ms, the first sleep comes after about 9 chunks, the rest yield", async () => {
		seedPlain(800, DIM);
		const clock = createFakeClock({ autoAdvance: true });
		const statementsAtSleep: number[] = [];
		scan.__setVectorScanClockForTests({
			now: clock.now,
			sleep: (ms) => {
				statementsAtSleep.push(meter.matching(CHUNK_SQL).length);
				return clock.sleep(ms);
			},
		});
		meter.setAfterExecute((execution) => {
			if (CHUNK_SQL.test(execution.sql)) clock.advance(0.1);
		});
		setBudgets({ share: 0.3 });
		const immediates = spyOn(globalThis, "setImmediate");
		let yields = 0;
		try {
			await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
				model: MODEL,
				dim: DIM,
			});
			yields = immediates.mock.calls.length;
		} finally {
			immediates.mockRestore();
		}

		expect(clock.sleeps.length).toBeGreaterThan(2);
		for (const slept of clock.sleeps) expect(slept).toBeGreaterThanOrEqual(2);
		expect(statementsAtSleep[0]).toBeGreaterThanOrEqual(9);
		expect(statementsAtSleep[0]).toBeLessThanOrEqual(10);
		// 50 chunks: every gap that isn't a sleep yields to the event loop.
		expect(yields).toBeGreaterThanOrEqual(50 - clock.sleeps.length);
	});

	test("oversleeping earns no credit; undersleeping adds the shortfall back; the long-run ratio holds", async () => {
		seedPlain(800, DIM);
		const query = randomUnitVector(makeRng(9), DIM);

		const over = createFakeClock();
		const oversleeps: number[] = [];
		scan.__setVectorScanClockForTests({
			now: over.now,
			sleep: async (ms) => {
				oversleeps.push(ms);
				over.advance(ms + 1);
			},
		});
		meter.setAfterExecute((execution) => {
			if (CHUNK_SQL.test(execution.sql)) over.advance(10);
		});
		setBudgets({ share: 0.3 });
		await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		for (const slept of oversleeps) expect(Math.abs(slept - 23.33)).toBeLessThan(0.1);

		scan.__resetVectorScanStateForTests();
		const under = createFakeClock();
		const undersleeps: number[] = [];
		scan.__setVectorScanClockForTests({
			now: under.now,
			sleep: async (ms) => {
				undersleeps.push(ms);
				under.advance(ms - 3.33);
			},
		});
		meter.setAfterExecute((execution) => {
			if (CHUNK_SQL.test(execution.sql)) under.advance(10);
		});
		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(Math.abs((undersleeps[0] as number) - 23.33)).toBeLessThan(0.1);
		expect(Math.abs((undersleeps[1] as number) - 26.66)).toBeLessThan(0.1);
		for (const slept of undersleeps) expect(slept).toBeGreaterThan(0);
		const { busyMs, sleptMs } = result.stats;
		expect(Math.abs(sleptMs / (busyMs + sleptMs) - 0.7)).toBeLessThan(0.02);
	});

	test("share 1 never sleeps; share 0.05 sleeps 95% of the time; the share is read when the scan runs", async () => {
		seedPlain(800, DIM);
		const query = randomUnitVector(makeRng(9), DIM);
		const clock = useFakeClock(10);

		setBudgets({ share: 1 });
		const unpaced = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(clock.sleeps.length).toBe(0);
		expect(unpaced.stats.sleptMs).toBe(0);

		setBudgets({ share: 0.05 });
		const slow = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		const { busyMs, sleptMs } = slow.stats;
		expect(Math.abs(sleptMs / (busyMs + sleptMs) - 0.95)).toBeLessThan(0.02);
	});

	test("with a share of 1 no timer of 1 ms or less is armed during the scan", async () => {
		seedPlain(800, DIM);
		const timers = spyOn(globalThis, "setTimeout");
		try {
			await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
				model: MODEL,
				dim: DIM,
			});
		} finally {
			timers.mockRestore();
		}
		const tiny = timers.mock.calls.filter(([, delay]) => delay === undefined || Number(delay) <= 1);
		expect(tiny.length).toBe(0);
	});
});

describeSqliteOnly("one pacer for every scan in the process", () => {
	async function twoScans(chunkCostMs: number) {
		seedPlain(800, DIM);
		const clock = useFakeClock(chunkCostMs, { autoAdvance: false });
		setBudgets({ share: 0.3 });
		let statementsWhileSleeping = 0;
		meter.setAfterExecute((execution) => {
			if (!CHUNK_SQL.test(execution.sql)) return;
			if (clock.pendingTimers() > 0) statementsWhileSleeping++;
			clock.advance(chunkCostMs);
		});
		const a = scan.scanSessionSimilarity(randomUnitVector(makeRng(21), DIM), {
			model: MODEL,
			dim: DIM,
		});
		const b = scan.scanSessionSimilarity(randomUnitVector(makeRng(22), DIM), {
			model: MODEL,
			dim: DIM,
		});
		const both = await runWithClock(clock, Promise.all([a, b]));
		return { clock, both, statementsWhileSleeping };
	}

	test("two concurrent scans together use the configured share, not twice it", async () => {
		const { clock, both } = await twoScans(10);
		const busy = both.reduce((sum, r) => sum + r.stats.busyMs, 0);
		expect(busy).toBe(1_020);
		const sleptFraction = 1 - busy / clock.now();
		expect(Math.abs(sleptFraction - 0.7)).toBeLessThan(0.02);
		for (const r of both) expect(r.stats.returned).toBe(800);
	});

	test("while one scan sleeps the other issues no statement", async () => {
		const { statementsWhileSleeping } = await twoScans(10);
		expect(statementsWhileSleeping).toBe(0);
	});

	test("debt is never negative and one sleeper pays a given debt", async () => {
		const { clock, both } = await twoScans(10);
		for (const slept of clock.sleeps) expect(slept).toBeGreaterThan(0);
		const debtGenerated = both.reduce((sum, r) => sum + r.stats.busyMs, 0) * (0.7 / 0.3);
		const totalSlept = clock.sleeps.reduce((sum, s) => sum + s, 0);
		expect(totalSlept).toBeLessThanOrEqual(debtGenerated + 1);
		expect(totalSlept).toBeGreaterThan(debtGenerated - 2 * 23.4);
	});

	test("a chunk that throws still pays its debt: the next scan sleeps one chunk's worth before its first statement", async () => {
		seedPlain(800, DIM);
		const clock = createFakeClock({ autoAdvance: true });
		const sleepsAt: Array<{ ms: number; statementsSoFar: number }> = [];
		scan.__setVectorScanClockForTests({
			now: clock.now,
			sleep: (ms) => {
				sleepsAt.push({ ms, statementsSoFar: meter.matching(CHUNK_SQL).length });
				return clock.sleep(ms);
			},
		});
		setBudgets({ share: 0.3 });
		let chunk = 0;
		meter.setAfterExecute((execution) => {
			if (!CHUNK_SQL.test(execution.sql)) return;
			clock.advance(10);
			if (++chunk === 3) throw new Error("disk I/O error");
		});
		const query = randomUnitVector(makeRng(9), DIM);
		await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM })).rejects.toThrow(
			/disk I\/O/,
		);
		const statementsBeforeSecondScan = meter.matching(CHUNK_SQL).length;
		const sleepsBeforeSecondScan = sleepsAt.length;
		meter.setAfterExecute((execution) => {
			if (CHUNK_SQL.test(execution.sql)) clock.advance(10);
		});

		await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });

		const first = sleepsAt[sleepsBeforeSecondScan];
		expect(first?.statementsSoFar).toBe(statementsBeforeSecondScan);
		expect(Math.abs((first?.ms ?? 0) - 23.33)).toBeLessThan(1);
	});

	test("two scans with no mutex both complete within their own budgets, each with correct results", async () => {
		const queryA = randomUnitVector(makeRng(31), DIM);
		const queryB = randomUnitVector(makeRng(32), DIM);
		seedMixed(400, DIM, queryA, 41);
		const [a, b] = await Promise.all([
			scan.scanSessionSimilarity(queryA, { model: MODEL, dim: DIM }),
			scan.scanSessionSimilarity(queryB, { model: MODEL, dim: DIM }),
		]);
		const expectedA = oracle(queryA, MODEL, DIM);
		expect(a.perSession.size).toBe(expectedA.size);
		for (const [session, value] of expectedA) expect(a.perSession.get(session)).toEqual(value);
		expect(b.perSession.size).toBe(oracle(queryB, MODEL, DIM).size);
		expect(a.stats.returned).toBe(400);
		expect(b.stats.returned).toBe(400);
	});
});

describeSqliteOnly("rows that cannot be scored", () => {
	test("blobs of the wrong length are skipped before scoring; valid rows around them still score", async () => {
		const query = randomUnitVector(makeRng(5), DIM);
		const good = (id: number) => ({
			id,
			sessionId: "good",
			model: MODEL,
			dim: DIM,
			vector: query as Float32Array | Uint8Array,
		});
		ensureSessions(["good", "short", "long", "empty"]);
		seedRows([
			good(1),
			{ ...good(2), sessionId: "short", vector: new Uint8Array(DIM * 4 - 4) },
			good(3),
			{ ...good(4), sessionId: "long", vector: new Uint8Array(DIM * 4 + 4) },
			{ ...good(5), sessionId: "empty", vector: new Uint8Array(0) },
			good(6),
		]);

		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });

		expect(result.stats.skipped).toBe(3);
		expect(result.stats.scored).toBe(3);
		expect(result.stats.returned).toBe(6);
		expect(result.perSession.get("good")?.count).toBe(3);
		expect(result.perSession.has("short")).toBe(false);
	});

	test("an empty table, and a table holding only another model, give an empty exhausted result", async () => {
		const query = randomUnitVector(makeRng(5), 8);
		const empty = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 });
		expect(empty.perSession.size).toBe(0);
		expect(empty.stats.stopReason).toBe("exhausted");

		seedPlain(50, 8, 3, "another-model");
		const other = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 });
		expect(other.perSession.size).toBe(0);
		expect(other.stats.returned).toBe(0);
		expect(other.stats.stopReason).toBe("exhausted");
	});
});

describeSqliteOnly("stats", () => {
	test("stats match what the statement meter saw and the fake clock measured", async () => {
		seedPlain(400, DIM);
		const clock = useFakeClock(10);
		setBudgets({ share: 0.3 });

		const result = await scan.scanSessionSimilarity(randomUnitVector(makeRng(9), DIM), {
			model: MODEL,
			dim: DIM,
		});

		const chunks = meter.matching(CHUNK_SQL);
		expect(chunks.length).toBeGreaterThan(0);
		const { stats } = result;
		expect(stats.statements).toBe(chunks.length);
		expect(stats.maxRowsPerStatement).toBe(Math.max(...chunks.map((c) => c.rows)));
		expect(stats.scored + stats.skipped).toBe(stats.returned);
		expect(stats.busyMs).toBeCloseTo(10 * chunks.length, 5);
		expect(stats.sleptMs).toBeCloseTo(
			clock.sleeps.reduce((sum, s) => sum + s, 0),
			5,
		);
		expect(stats.maxSliceMs).toBeCloseTo(10, 5);
		expect(stats.model).toBe(MODEL);
		expect(stats.dim).toBe(DIM);
		expect(scan.getLastVectorScanStats()).toEqual(stats);
	});

	test("the oldest covered event is its id and its creation time as ISO 8601 UTC, found with at most one extra statement", async () => {
		ensureSessions(["s-1"]);
		seedRows([
			{
				id: 1,
				sessionId: "s-1",
				model: MODEL,
				dim: 4,
				vector: new Float32Array(4),
				createdAt: "2026-03-04 05:06:07",
			},
			{ id: 2, sessionId: "s-1", model: MODEL, dim: 4, vector: new Float32Array(4) },
		]);

		const result = await scan.scanSessionSimilarity(new Float32Array(4), { model: MODEL, dim: 4 });

		expect(result.stats.oldestEventId).toBe(1);
		expect(result.stats.oldestEventAt).toBe("2026-03-04T05:06:07.000Z");
		expect(meter.matching(/FROM events\b/).length).toBeLessThanOrEqual(1);
	});

	test("a scan that reached only orphans has no oldest event time", async () => {
		seedRows([
			{
				id: 10,
				sessionId: "none",
				model: MODEL,
				dim: 4,
				vector: new Float32Array(4),
				orphan: true,
			},
		]);
		const result = await scan.scanSessionSimilarity(new Float32Array(4), { model: MODEL, dim: 4 });
		expect(result.stats.skipped).toBe(1);
		expect(result.stats.oldestEventAt).toBeNull();
	});
});

describeSqliteOnly("a missing index or a failing statement", () => {
	test("the scan rejects, the index state reads missing, and recreating the index recovers", async () => {
		seedPlain(100, 8);
		const query = randomUnitVector(makeRng(5), 8);
		expect(scan.getVectorScanIndexState()).toBe("unknown");

		getSqlite().exec(`DROP INDEX ${INDEX}`);
		await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 })).rejects.toThrow(
			/no such index/,
		);
		expect(scan.getVectorScanIndexState()).toBe("missing");

		getSqlite().exec(`CREATE INDEX ${INDEX} ON event_embeddings (model, dim, event_id)`);
		const recovered = await scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 });
		expect(recovered.stats.returned).toBe(100);
		expect(scan.getVectorScanIndexState()).toBe("ok");
	});

	test("an error in the middle of a scan rejects it and a later scan works", async () => {
		seedPlain(800, DIM);
		const query = randomUnitVector(makeRng(5), DIM);
		let chunk = 0;
		meter.setAfterExecute((execution) => {
			if (CHUNK_SQL.test(execution.sql) && ++chunk === 3) throw new Error("disk I/O error");
		});
		await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM })).rejects.toThrow(
			/disk I\/O/,
		);
		meter.setAfterExecute(null);
		const later = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		expect(later.stats.returned).toBe(800);
	});

	test("the failure is logged once per boot per reason, with no query text, and again after a reset", async () => {
		seedPlain(100, 8);
		const query = randomUnitVector(makeRng(5), 8);
		const logs = captureLogs();
		try {
			getSqlite().exec(`DROP INDEX ${INDEX}`);
			for (let i = 0; i < 2; i++) {
				await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 })).rejects.toThrow();
			}
			const errors = () => logs.lines.filter((l) => l.kind === "ask_vector_scan_error");
			expect(errors().length).toBe(1);
			expect(JSON.stringify(errors()[0])).not.toContain("INDEXED BY");

			let chunk = 0;
			meter.setAfterExecute((execution) => {
				if (CHUNK_SQL.test(execution.sql) && ++chunk === 1) throw new Error("disk I/O error");
			});
			getSqlite().exec(`CREATE INDEX ${INDEX} ON event_embeddings (model, dim, event_id)`);
			await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 })).rejects.toThrow();
			expect(errors().length).toBe(2);
			expect(new Set(errors().map((l) => l.reason)).size).toBe(2);

			scan.__resetVectorScanStateForTests();
			getSqlite().exec(`DROP INDEX ${INDEX}`);
			meter.setAfterExecute(null);
			await expect(scan.scanSessionSimilarity(query, { model: MODEL, dim: 8 })).rejects.toThrow();
			expect(errors().length).toBe(3);
		} finally {
			logs.restore();
		}
	});

	test("coverage_partial is logged once per boot, on the first truncated scan only", async () => {
		seedPlain(400, DIM);
		const query = randomUnitVector(makeRng(5), DIM);
		const logs = captureLogs();
		const partial = () => logs.lines.filter((l) => l.kind === "vector_scan_coverage_partial");
		try {
			await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
			expect(partial().length).toBe(0);

			setBudgets({ maxRows: 100 });
			await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
			await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
			expect(partial().length).toBe(1);

			scan.__resetVectorScanStateForTests();
			await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
			expect(partial().length).toBe(2);
		} finally {
			logs.restore();
		}
	});
});
