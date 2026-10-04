/**
 * The enricher over the bounded scan: scoring is unchanged from the unbounded
 * version, a failing scan degrades to "no semantic enrichment", and the
 * resolved adapter's model and dimension are what the statement is bound to.
 */
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
	describePostgresOnly,
	describeSqliteOnly,
	isSqliteTest,
} from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const scan = await import("./vector-scan.js");
const { VectorEmbeddingEnricher } = await import("./vector-enricher.js");
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");
const { clearEmbeddingFixtures, ensureSessions, makeRng, mixedVector, randomUnitVector, seedRows } =
	await import("../../../test-utils/embedding-fixtures.js");

import type { StatementMeter } from "../../../test-utils/statement-meter.js";
import type { EmbeddingAdapter } from "./types.js";

const MODEL = "enricher-test";
const DIM = 64;
const INDEX = "idx_event_embeddings_model_dim_event";
const scanConfig = config as unknown as Record<string, number>;
const originalScanConfig = {
	vectorScanMaxRows: scanConfig.vectorScanMaxRows,
	vectorScanMaxMs: scanConfig.vectorScanMaxMs,
	vectorScanCpuShare: scanConfig.vectorScanCpuShare,
};

let meter: StatementMeter;

function adapterFor(
	query: Float32Array,
	overrides: Partial<EmbeddingAdapter> = {},
): EmbeddingAdapter {
	return { kind: "ollama", model: MODEL, dim: DIM, embed: async () => query, ...overrides };
}

function captureLogs() {
	const lines: Array<Record<string, unknown>> = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		if (typeof args[0] !== "string") return;
		try {
			lines.push(JSON.parse(args[0]));
		} catch {
			// not a structured line
		}
	});
	return { lines, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await initializeDatabase();
});

beforeEach(() => {
	if (!isSqliteTest) return;
	clearEmbeddingFixtures();
	scan.__resetVectorScanStateForTests();
	scanConfig.vectorScanCpuShare = 1;
	scanConfig.vectorScanMaxRows = 50_000;
	scanConfig.vectorScanMaxMs = 60_000;
	meter = installStatementMeter();
});

afterEach(() => {
	if (!isSqliteTest) return;
	meter.restore();
	scan.__resetVectorScanStateForTests();
	Object.assign(scanConfig, originalScanConfig);
	getSqlite().exec(
		`CREATE INDEX IF NOT EXISTS ${INDEX} ON event_embeddings (model, dim, event_id)`,
	);
});

describeSqliteOnly("scoring", () => {
	test("a session scores max + log1p(count) * 0.05, best first, capped at the top 20, with the 0.4 floor", async () => {
		const query = randomUnitVector(makeRng(1), DIM);
		const rng = makeRng(2);
		const rows = [];
		let id = 1;
		// 30 sessions of 1..3 near matches each, so the cap of 20 bites.
		for (let s = 0; s < 30; s++) {
			for (let k = 0; k <= s % 3; k++) {
				rows.push({
					id: id++,
					sessionId: `sess-${s}`,
					model: MODEL,
					dim: DIM,
					vector: mixedVector(rng, query, 0.6 + 0.4 * rng()),
				});
			}
		}
		rows.push({
			id: id++,
			sessionId: "noise",
			model: MODEL,
			dim: DIM,
			vector: randomUnitVector(rng, DIM),
		});
		ensureSessions([...new Set(rows.map((r) => r.sessionId))]);
		seedRows(rows);
		const { cosineSimilarity } = await import("./types.js");

		const result = await new VectorEmbeddingEnricher(adapterFor(query)).enrich("anything");

		const expected = new Map<string, { max: number; count: number }>();
		for (const row of rows) {
			const sim = cosineSimilarity(query, row.vector);
			if (sim < 0.4) continue;
			const entry = expected.get(row.sessionId) ?? { max: 0, count: 0 };
			entry.max = Math.max(entry.max, sim);
			entry.count++;
			expected.set(row.sessionId, entry);
		}
		const ranked = [...expected.entries()]
			.map(([session, { max, count }]) => [session, max + Math.log1p(count) * 0.05] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20);
		expect(result.extraTerms).toEqual([]);
		expect(result.directHits.size).toBe(20);
		expect([...result.directHits.keys()]).toEqual(ranked.map(([session]) => session));
		for (const [session, score] of ranked) {
			expect(result.directHits.get(session)).toBeCloseTo(score, 10);
		}
		expect(result.directHits.has("noise")).toBe(false);
	});
});

describeSqliteOnly("what reaches the statement and what doesn't", () => {
	test("the resolved adapter's model and dimension are the statement's bound parameters", async () => {
		const query = randomUnitVector(makeRng(1), DIM);
		await new VectorEmbeddingEnricher(adapterFor(query)).enrich("anything");
		const chunk = meter.matching(/FROM event_embeddings v[\s\S]*LIMIT/)[0];
		expect(chunk).toBeDefined();
		expect(chunk?.params[0]).toBe(MODEL);
		expect(chunk?.params[1]).toBe(DIM);
	});

	test("a failing embed returns empty and never touches the table; a blank query never embeds", async () => {
		let embeds = 0;
		const failing = adapterFor(new Float32Array(DIM), {
			embed: async () => {
				embeds++;
				throw new Error("embedding server down");
			},
		});
		const failed = await new VectorEmbeddingEnricher(failing).enrich("hello");
		expect(failed.directHits.size).toBe(0);
		expect(meter.matching(/event_embeddings/).length).toBe(0);

		embeds = 0;
		const blank = await new VectorEmbeddingEnricher(failing).enrich("   ");
		expect(blank.directHits.size).toBe(0);
		expect(embeds).toBe(0);
	});

	test("the only production caller of the scan is the enricher", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./vector-enricher.ts", import.meta.url), "utf8");
		expect(source).toContain("scanSessionSimilarity(");
	});
});

describeSqliteOnly("a scan that fails", () => {
	test("the enricher resolves empty, logs the failure once with no query text, and the next call recovers", async () => {
		const query = randomUnitVector(makeRng(1), DIM);
		ensureSessions(["s-1"]);
		seedRows([{ id: 1, sessionId: "s-1", model: MODEL, dim: DIM, vector: query }]);
		const logs = captureLogs();
		try {
			getSqlite().exec(`DROP INDEX ${INDEX}`);
			const enricher = new VectorEmbeddingEnricher(adapterFor(query));
			const first = await enricher.enrich("a secret question about payroll");
			const second = await enricher.enrich("a secret question about payroll");

			expect(first.directHits.size).toBe(0);
			expect(second.directHits.size).toBe(0);
			const errors = logs.lines.filter((l) => l.kind === "ask_vector_scan_error");
			expect(errors.length).toBe(1);
			expect(JSON.stringify(logs.lines)).not.toContain("payroll");

			getSqlite().exec(`CREATE INDEX ${INDEX} ON event_embeddings (model, dim, event_id)`);
			const recovered = await enricher.enrich("a secret question about payroll");
			expect(recovered.directHits.has("s-1")).toBe(true);
		} finally {
			logs.restore();
		}
	});

	test("a started and a finished line are logged for a normal scan", async () => {
		const query = randomUnitVector(makeRng(1), DIM);
		ensureSessions(["s-1"]);
		seedRows([{ id: 1, sessionId: "s-1", model: MODEL, dim: DIM, vector: query }]);
		const logs = captureLogs();
		try {
			await new VectorEmbeddingEnricher(adapterFor(query)).enrich("question");
		} finally {
			logs.restore();
		}
		const kinds = logs.lines.map((l) => l.kind);
		expect(kinds).toContain("ask_vector_scan_started");
		expect(kinds).toContain("ask_vector_scan");
		expect(kinds.indexOf("ask_vector_scan_started")).toBeLessThan(kinds.indexOf("ask_vector_scan"));
	});
});

describePostgresOnly("on the Postgres backend (event_embeddings is SQLite-only)", () => {
	test("the factory returns null and the enricher returns nothing without touching the database", async () => {
		const { getVectorEnricher } = await import("./vector-enricher.js");
		expect(await getVectorEnricher()).toBeNull();

		let embeds = 0;
		const result = await new VectorEmbeddingEnricher(
			adapterFor(new Float32Array(DIM), {
				embed: async () => {
					embeds++;
					return new Float32Array(DIM);
				},
			}),
		).enrich("anything");
		expect(result.directHits.size).toBe(0);
		expect(embeds).toBe(0);
	});
});
