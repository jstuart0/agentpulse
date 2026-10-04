/**
 * Child-process half of `vector-scan.shapes.test.ts`. One process holds one
 * SQLite shape, so the parent runs this file twice: once against a database
 * created by the Drizzle migrator and once against an existing install booted
 * through the legacy init path. It does nothing unless the parent asks.
 *
 * Every assertion about stale suffixes, orphans, skip markers and mixed
 * models lives here so it runs on both shapes.
 */
import { Database } from "bun:sqlite";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const SHAPE = process.env.AGENTPULSE_SCAN_SHAPE as "legacy" | "drizzle" | undefined;
const describeChild = SHAPE ? describe : describe.skip;

if (SHAPE === "legacy") {
	const path = process.env.SQLITE_PATH as string;
	if (!existsSync(path)) {
		const seed = new Database(path, { create: true });
		seed.exec(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			total_tool_uses INTEGER NOT NULL DEFAULT 0,
			metadata TEXT DEFAULT '{}'
		)`);
		seed.close();
	}
}

await import("../../../db/__test_db.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const scan = await import("./vector-scan.js");
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");
const { clearEmbeddingFixtures, ensureSessions, makeRng, randomUnitVector, seedRows } =
	await import("../../../test-utils/embedding-fixtures.js");

const MODEL = "shape-4096";
const DIM = 4096;
const CHUNK_SQL = /FROM event_embeddings v[\s\S]*LIMIT/;
const scanConfig = (await import("../../../config.js")).config as unknown as Record<string, number>;

function plantQuery(seed: number) {
	return randomUnitVector(makeRng(seed), DIM);
}

/** `count` rows of the active model at ids `from..from+count-1`, each its own session, all identical to `vector`. */
function activeRows(from: number, count: number, vector: Float32Array) {
	return Array.from({ length: count }, (_, i) => ({
		id: from + i,
		sessionId: `active-${from + i}`,
		model: MODEL,
		dim: DIM,
		vector,
	}));
}

async function scanAndMeter(query: Float32Array) {
	const meter = installStatementMeter();
	try {
		const result = await scan.scanSessionSimilarity(query, { model: MODEL, dim: DIM });
		return { result, chunks: meter.matching(CHUNK_SQL) };
	} finally {
		meter.restore();
	}
}

function planOfScan(chunkSql: string, params: unknown[]): string {
	const rows = getSqlite()
		.prepare(`EXPLAIN QUERY PLAN ${chunkSql}`)
		.all(...(params as never[])) as Array<{ detail: string }>;
	return rows.map((r) => r.detail).join("\n");
}

describeChild(`scan on the ${SHAPE ?? "-"} install shape`, () => {
	beforeAll(async () => {
		await initializeDatabase();
		const sqlite = getSqlite();
		const names = (type: string) =>
			(
				sqlite.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{
					name: string;
				}>
			).map((r) => r.name);
		console.log(
			`SCAN_SHAPE_REPORT ${JSON.stringify({
				shape: SHAPE,
				hasDrizzleMigrations: names("table").includes("__drizzle_migrations"),
				hasLegacyModelIndex: names("index").includes("idx_event_embeddings_model"),
				hasDeleteTrigger: names("trigger").includes("trg_events_ad_embeddings"),
				hasScanIndex: names("index").includes("idx_event_embeddings_model_dim_event"),
			})}`,
		);
	});

	beforeEach(() => {
		clearEmbeddingFixtures();
		scan.__resetVectorScanStateForTests();
		scanConfig.vectorScanCpuShare = 1;
		scanConfig.vectorScanMaxRows = 50_000;
		scanConfig.vectorScanMaxMs = 60_000;
		getSqlite().exec(
			"CREATE INDEX IF NOT EXISTS idx_event_embeddings_model_dim_event ON event_embeddings (model, dim, event_id)",
		);
	});

	test("the newest 3,000 rows belong to another model: every statement still returns 16 active rows and the plan seeks the index", async () => {
		const query = plantQuery(1);
		ensureSessions(["other"]);
		seedRows(activeRows(1, 1_000, query));
		const otherRows = Array.from({ length: 3_000 }, (_, i) => ({
			id: 1_001 + i,
			sessionId: "other",
			model: "someone-else",
			dim: 8,
			vector: new Float32Array(8),
		}));
		seedRows(otherRows);

		const { result, chunks } = await scanAndMeter(query);

		expect(chunks[0]?.rows).toBe(16);
		expect(chunks.slice(0, -1).every((c) => c.rows === 16)).toBe(true);
		expect(result.stats.returned).toBe(1_000);
		expect(result.stats.statements).toBe(63);
		const first = chunks[0] as (typeof chunks)[number];
		const plan = planOfScan(first.sql, first.params);
		expect(plan).toContain("idx_event_embeddings_model_dim_event");
		expect(plan).not.toMatch(/SCAN v/);
		expect(plan).not.toMatch(/TEMP B-TREE/);
	});

	test("the newest 3,000 rows are the same model at another dimension: the seek excludes them", async () => {
		const query = plantQuery(2);
		ensureSessions(["wrong-dim"]);
		seedRows(activeRows(1, 500, query));
		seedRows(
			Array.from({ length: 3_000 }, (_, i) => ({
				id: 501 + i,
				sessionId: "wrong-dim",
				model: MODEL,
				dim: 8,
				vector: new Float32Array(8),
			})),
		);

		const { result, chunks } = await scanAndMeter(query);

		expect(result.stats.returned).toBe(500);
		expect(chunks.every((c) => c.rows <= 16)).toBe(true);
		expect(chunks[0]?.rows).toBe(16);
	});

	test("skip markers (dim 0) are never returned or counted, scattered or as a 3,000-row newest run", async () => {
		const query = plantQuery(3);
		ensureSessions(["marked"]);
		seedRows(activeRows(1, 400, query));
		const scattered = Array.from({ length: 100 }, (_, i) => ({
			id: 10_000 + i,
			sessionId: "marked",
			model: MODEL,
			dim: 0,
			vector: new Uint8Array(0),
		}));
		const run = Array.from({ length: 3_000 }, (_, i) => ({
			id: 20_000 + i,
			sessionId: "marked",
			model: MODEL,
			dim: 0,
			vector: new Uint8Array(0),
		}));
		seedRows([...scattered, ...run]);

		const { result, chunks } = await scanAndMeter(query);

		expect(result.stats.returned).toBe(400);
		expect(result.stats.skipped).toBe(0);
		expect(chunks[0]?.rows).toBe(16);
	});

	test("orphan vectors (no events row) cost 16 rows and no blob bytes per statement, count as skipped and spend the budget", async () => {
		const query = plantQuery(4);
		ensureSessions(["real"]);
		seedRows(activeRows(1, 200, query));
		seedRows(
			Array.from({ length: 3_000 }, (_, i) => ({
				id: 1_000 + i,
				sessionId: "gone",
				model: MODEL,
				dim: DIM,
				vector: query,
				orphan: true,
			})),
		);

		scanConfig.vectorScanMaxRows = 500;
		const { result, chunks } = await scanAndMeter(query);

		expect(chunks[0]?.rows).toBe(16);
		expect(chunks[0]?.bytes).toBeLessThan(16 * 100);
		expect(result.stats.stopReason).toBe("row_budget");
		expect(result.stats.scored).toBe(0);
		expect(result.stats.skipped).toBeGreaterThanOrEqual(500);
	});

	test("orphans made by deleting events with the cascade trigger dropped behave the same", async () => {
		const query = plantQuery(5);
		ensureSessions(["doomed", "real"]);
		seedRows(activeRows(1, 100, query));
		seedRows(
			Array.from({ length: 800 }, (_, i) => ({
				id: 1_000 + i,
				sessionId: "doomed",
				model: MODEL,
				dim: DIM,
				vector: query,
			})),
		);
		getSqlite().exec("DROP TRIGGER IF EXISTS trg_events_ad_embeddings");
		getSqlite().exec("DELETE FROM events WHERE session_id = 'doomed'");

		const { result, chunks } = await scanAndMeter(query);

		expect(chunks.every((c) => c.rows <= 16)).toBe(true);
		expect(chunks[0]?.bytes).toBeLessThan(16 * 100);
		expect(result.stats.skipped).toBe(800);
		expect(result.stats.scored).toBe(100);
	});

	test("two models interleaved: scanning one returns exactly its rows, and the other's never spend the budget", async () => {
		const query = plantQuery(6);
		ensureSessions(["a", "b"]);
		const rows = [];
		for (let i = 0; i < 1_200; i++) {
			const mine = i % 2 === 0;
			rows.push({
				id: i + 1,
				sessionId: mine ? "a" : "b",
				model: mine ? MODEL : "other-model",
				dim: mine ? DIM : 8,
				vector: mine ? query : new Float32Array(8),
			});
		}
		seedRows(rows);

		const { result } = await scanAndMeter(query);

		expect(result.stats.returned).toBe(600);
		expect(result.perSession.get("a")?.count).toBe(600);
		expect(result.perSession.has("b")).toBe(false);
		expect(result.stats.statements).toBeLessThanOrEqual(Math.ceil(600 / 16) + 1);
	});

	test("the index exists on this shape", () => {
		const row = getSqlite()
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get("idx_event_embeddings_model_dim_event");
		expect(row).not.toBeNull();
	});
});
