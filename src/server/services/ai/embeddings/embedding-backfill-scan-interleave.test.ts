/**
 * The backfill and an Ask scan share one SQLite connection and one event loop.
 * Each does its work in short synchronous slices and yields to the loop
 * between them (the backfill after every batch or empty window, the scan
 * after every chunk, plus its CPU pacing), so running together neither may
 * starve the other. At small scale that is visible as interleaving: in the
 * order the statements reach SQLite, scan chunks and backfill batches
 * alternate, and neither runs long unbroken while the other still has work.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const service = await import("./embedding-service.js");
const scan = await import("./vector-scan.js");
const fixtures = await import("../../../test-utils/embedding-fixtures.js");
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");

import type { StatementMeter } from "../../../test-utils/statement-meter.js";

const MODEL = "interleave-model";
const DIM = 4096;
const scanConfig = config as unknown as Record<string, number>;
const originalVectorSearch = config.vectorSearchEnabled;
const originalShare = scanConfig.vectorScanCpuShare;

let meter: StatementMeter;

beforeAll(async () => {
	if (!isSqliteTest) return;
	await initializeDatabase();
	(config as Record<string, unknown>).vectorSearchEnabled = true;
});
afterAll(() => {
	if (!isSqliteTest) return;
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	service.__resetEmbeddingAdapterForTests();
});
beforeEach(() => {
	if (!isSqliteTest) return;
	fixtures.resetEmbeddingWorld();
	scan.__resetVectorScanStateForTests();
	scanConfig.vectorScanCpuShare = 1;
	meter = installStatementMeter();
});
afterEach(() => {
	if (!isSqliteTest) return;
	meter.restore();
	scan.__resetVectorScanStateForTests();
	scanConfig.vectorScanCpuShare = originalShare;
});

describeSqliteOnly("a backfill and a scan at the same time", () => {
	test("both finish, and their statements alternate: neither runs long unbroken while the other has work", async () => {
		// 480 stored vectors for the scan (30 chunks of 16 at 4096 dims), 400 events for the backfill.
		const query = fixtures.randomUnitVector(fixtures.makeRng(1), DIM);
		fixtures.seedRandomRange({ startId: 1, count: 480, model: "scan-model", dim: DIM, seed: 3 });
		// The scan's events are not embeddable, so the backfill leaves their vectors alone.
		getSqlite().exec("UPDATE events SET event_type = 'PreToolUse'");
		for (let i = 0; i < 400; i++) {
			fixtures.insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `pending ${i}` } });
		}
		service.__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: MODEL,
			dim: 4,
			embed: async () => new Float32Array(4).fill(0.1),
		});
		meter.executions.length = 0;

		const kinds: Array<"scan" | "backfill"> = [];
		meter.setAfterExecute((e) => {
			if (/FROM event_embeddings v[\s\S]*LIMIT/.test(e.sql)) kinds.push("scan");
			else if (/FROM events e\b/.test(e.sql)) kinds.push("backfill");
		});

		const [backfill, scanResult] = await Promise.all([
			service.runBackfill(),
			scan.scanSessionSimilarity(query, { model: "scan-model", dim: DIM }),
		]);

		expect(backfill.error).toBeNull();
		expect(backfill.running).toBe(false);
		expect(scanResult.stats.stopReason).toBe("exhausted");
		expect(scanResult.stats.returned).toBe(480);
		expect(
			(
				getSqlite()
					.prepare("SELECT COUNT(*) AS n FROM event_embeddings WHERE model = ?")
					.get(MODEL) as { n: number }
			).n,
		).toBe(400);

		// Longest unbroken run of one kind, counted only while the other still has statements to come.
		let longest = 0;
		let run = 0;
		for (let i = 0; i < kinds.length; i++) {
			run = i > 0 && kinds[i] === kinds[i - 1] ? run + 1 : 1;
			const otherRemains = kinds.slice(i + 1).some((k) => k !== kinds[i]);
			if (otherRemains) longest = Math.max(longest, run);
		}
		const switches = kinds.filter((k, i) => i > 0 && k !== kinds[i - 1]).length;
		expect(switches).toBeGreaterThan(10);
		expect(longest).toBeLessThanOrEqual(4);
	}, 30_000);
});
