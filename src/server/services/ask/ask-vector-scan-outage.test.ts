/**
 * The 2026-10-04 outage: every Ask turn read every row of `event_embeddings`
 * into memory in one synchronous statement (164,349 vectors x 4096 dims,
 * about 2.7 GB). These tests assert what one statement may materialise and
 * what the event loop does between statements, never RSS or wall time:
 * those are integers fixed by the code's shape, so they hold on any machine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import "../ai/__test_db.js";

mock.module("../ai/llm/registry.js", () => ({
	getAdapter: () => ({
		complete: async () => ({
			text: "ok",
			usage: { estimated: true, inputTokens: 1, outputTokens: 1 },
		}),
	}),
}));

const { config } = await import("../../config.js");
const { getDb, getSqlite, initializeDatabase } = await import("../../db/client.js");
const { askMessages, askThreads } = await import("../../db/schema/index.js");
const { createProvider } = await import("../ai/providers-service.js");
const { invalidateAiFlagsCache } = await import("../ai/feature.js");
const { __setEmbeddingAdapterForTests, __resetEmbeddingAdapterForTests } = await import(
	"../ai/embeddings/embedding-service.js"
);
const { runAskTurn, runAskTurnStream } = await import("./ask-service.js");
const { installStatementMeter } = await import("../../test-utils/statement-meter.js");
const { startTicker } = await import("../../test-utils/ticker.js");
const { createFakeClock } = await import("../../test-utils/fake-clock.js");
const { clearEmbeddingFixtures, ensureSessions, makeRng, randomUnitVector, seedRows } =
	await import("../../test-utils/embedding-fixtures.js");

import type { StatementMeter } from "../../test-utils/statement-meter.js";

const ACTOR = { userId: null, label: "anonymous" as const };
const PLANTED_SESSION = "planted-session";
const MESSAGE = "hello there, remind me what the retry thing was about";
const EMBEDDINGS = /event_embeddings/;

const originalSecretsKey = config.secretsKey;
const originalVectorSearch = config.vectorSearchEnabled;
const scanConfig = config as unknown as Record<string, number>;
const originalScanConfig = {
	vectorScanMaxRows: scanConfig.vectorScanMaxRows,
	vectorScanMaxMs: scanConfig.vectorScanMaxMs,
	vectorScanCpuShare: scanConfig.vectorScanCpuShare,
};

let meter: StatementMeter;

function setSetting(key: string, value: unknown) {
	getSqlite()
		.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
		.run(key, JSON.stringify(value));
	invalidateAiFlagsCache();
}

function nextImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Seed `count` events of `dim` dims; event `plantedId` carries the query vector itself. */
function seedCorpus(opts: { count: number; dim: number; model: string; plantedId: number }) {
	const rng = makeRng(opts.dim * 7 + opts.count);
	const query = randomUnitVector(rng, opts.dim);
	const rows = [];
	for (let id = 1; id <= opts.count; id++) {
		rows.push({
			id,
			sessionId: id === opts.plantedId ? PLANTED_SESSION : `s-${id % 7}`,
			model: opts.model,
			dim: opts.dim,
			vector: id === opts.plantedId ? query : randomUnitVector(rng, opts.dim),
		});
	}
	ensureSessions([PLANTED_SESSION, ...Array.from({ length: 7 }, (_, i) => `s-${i}`)]);
	seedRows(rows);
	return query;
}

function useAdapter(model: string, dim: number, query: Float32Array) {
	__setEmbeddingAdapterForTests({ kind: "ollama", model, dim, embed: async () => query });
}

beforeAll(async () => {
	await initializeDatabase();
	config.secretsKey = "test-secrets-key-32-characters!!";
	(config as Record<string, unknown>).vectorSearchEnabled = true;
	await createProvider({
		userId: "local",
		name: "outage-provider",
		kind: "anthropic",
		model: "claude-test",
		apiKey: "sk-test-not-real",
		isDefault: true,
	});
	setSetting("ai.enabled", true);
	setSetting("vectorSearch.enabled", true);
});

afterAll(() => {
	config.secretsKey = originalSecretsKey;
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	__resetEmbeddingAdapterForTests();
});

beforeEach(async () => {
	await getDb().delete(askMessages).execute();
	await getDb().delete(askThreads).execute();
	clearEmbeddingFixtures();
	// No pacing sleeps: the ticker assertions are about statements and yields.
	scanConfig.vectorScanCpuShare = 1;
	scanConfig.vectorScanMaxRows = 50_000;
	scanConfig.vectorScanMaxMs = 60_000;
	meter = installStatementMeter();
});

afterEach(() => {
	meter.restore();
	Object.assign(scanConfig, originalScanConfig);
});

describe("an Ask turn over 1,200 stored vectors of 4096 dims", () => {
	test("no statement returns more than 16 rows or 256 KiB, and the planted neighbour is found", async () => {
		const query = seedCorpus({ count: 1_200, dim: 4096, model: "fake-4096", plantedId: 600 });
		useAdapter("fake-4096", 4096, query);

		const result = await runAskTurn({ message: MESSAGE, actor: ACTOR });

		const scans = meter.matching(EMBEDDINGS);
		expect(scans.length).toBeGreaterThan(0);
		expect(Math.max(...scans.map((e) => e.rows))).toBeLessThanOrEqual(16);
		expect(Math.max(...scans.map((e) => e.bytes))).toBeLessThanOrEqual(262_144);
		expect(scans.every((e) => e.method !== "iterate")).toBe(true);
		expect(result.assistantMessage.content.length).toBeGreaterThan(0);
		expect(result.includedSessionIds).toContain(PLANTED_SESSION);
	});

	test("the event loop turns between statements: one to two ticks, at most 16 rows per tick", async () => {
		const query = seedCorpus({ count: 1_200, dim: 4096, model: "fake-4096", plantedId: 600 });
		useAdapter("fake-4096", 4096, query);

		const ticker = startTicker();
		await nextImmediate(); // let the ticker's immediate run first, so the scan's yields queue behind it
		const ticksAtStatement: number[] = [];
		const rowsAtStatement: number[] = [];
		meter.setAfterExecute((execution) => {
			if (!EMBEDDINGS.test(execution.sql)) return;
			ticksAtStatement.push(ticker.ticks);
			rowsAtStatement.push(execution.rows);
		});
		await runAskTurn({ message: MESSAGE, actor: ACTOR });
		ticker.stop();

		expect(ticksAtStatement.length).toBeGreaterThan(60);
		let rowsSinceTick = 0;
		let maxRowsSinceTick = 0;
		for (let i = 0; i < ticksAtStatement.length; i++) {
			rowsSinceTick =
				i > 0 && ticksAtStatement[i] > (ticksAtStatement[i - 1] as number) ? 0 : rowsSinceTick;
			rowsSinceTick += rowsAtStatement[i] as number;
			maxRowsSinceTick = Math.max(maxRowsSinceTick, rowsSinceTick);
			if (i === 0) continue;
			const gap = (ticksAtStatement[i] as number) - (ticksAtStatement[i - 1] as number);
			expect(gap).toBeGreaterThanOrEqual(1);
			expect(gap).toBeLessThanOrEqual(2);
		}
		expect(maxRowsSinceTick).toBeLessThanOrEqual(16);
	});

	test("the streaming turn is bounded the same way", async () => {
		const query = seedCorpus({ count: 400, dim: 4096, model: "fake-4096", plantedId: 200 });
		useAdapter("fake-4096", 4096, query);

		for await (const _event of runAskTurnStream({ message: MESSAGE, actor: ACTOR })) {
			// drain
		}

		const scans = meter.matching(EMBEDDINGS);
		expect(scans.length).toBeGreaterThan(0);
		expect(Math.max(...scans.map((e) => e.rows))).toBeLessThanOrEqual(16);
		expect(Math.max(...scans.map((e) => e.bytes))).toBeLessThanOrEqual(262_144);
	});
});

describe("statement size follows the vector dimension", () => {
	for (const [dim, rowCap] of [
		[1024, 256],
		[64, 256],
	] as const) {
		test(`dim ${dim}: 300 rows stay under 256 KiB and ${rowCap} rows per statement`, async () => {
			const query = seedCorpus({ count: 300, dim, model: `fake-${dim}`, plantedId: 150 });
			useAdapter(`fake-${dim}`, dim, query);

			await runAskTurn({ message: MESSAGE, actor: ACTOR });

			const scans = meter.matching(EMBEDDINGS);
			expect(scans.length).toBeGreaterThan(0);
			expect(Math.max(...scans.map((e) => e.bytes))).toBeLessThanOrEqual(262_144);
			expect(Math.max(...scans.map((e) => e.rows))).toBeLessThanOrEqual(rowCap);
		});
	}
});

describe("the scan shares the process with everything else", () => {
	test("a real HTTP request and a real hook delivery are served while a paced scan is mid-flight", async () => {
		const { scanSessionSimilarity } = await import("../ai/embeddings/vector-scan.js");
		const { app } = await import("../../app.js");
		const { createApiKey } = await import("../../auth/api-key.js");
		const query = seedCorpus({ count: 1_200, dim: 4096, model: "fake-4096", plantedId: 600 });
		const { key } = await createApiKey(`outage-hook-${crypto.randomUUID()}`);
		const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
		// A small CPU share makes the scan sleep between chunks, so it spans real time.
		scanConfig.vectorScanCpuShare = 0.05;
		try {
			const scan = scanSessionSimilarity(query, { model: "fake-4096", dim: 4096 });
			let finished = false;
			scan.finally(() => {
				finished = true;
			});
			await nextImmediate();

			const health = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
			expect(health.status).toBeLessThan(500);
			const statementsAfterHealth = meter.matching(EMBEDDINGS).length;
			expect(finished).toBe(false);

			const sessionId = `hook-during-scan-${crypto.randomUUID()}`;
			const post = await fetch(`http://127.0.0.1:${server.port}/api/v1/hooks`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify({
					session_id: sessionId,
					hook_event_name: "UserPromptSubmit",
					prompt: "stored while the scan runs",
				}),
			});
			expect(post.status).toBe(200);
			let stored = false;
			for (let i = 0; i < 100 && !stored; i++) {
				stored =
					getSqlite().prepare("SELECT 1 AS x FROM events WHERE session_id = ?").get(sessionId) !=
					null;
				if (!stored) await Bun.sleep(5);
			}
			expect(stored).toBe(true);
			expect(finished).toBe(false);
			expect(meter.matching(EMBEDDINGS).length).toBeLessThan(76);
			expect(statementsAfterHealth).toBeLessThan(76);

			const result = await scan;
			expect(result.stats.stopReason).toBe("exhausted");
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("a setImmediate queued before the scan's first yield runs before its second statement", async () => {
		const { scanSessionSimilarity } = await import("../ai/embeddings/vector-scan.js");
		const query = seedCorpus({ count: 100, dim: 4096, model: "fake-4096", plantedId: 50 });
		let immediateRanAtStatement = -1;
		let statements = 0;
		meter.setAfterExecute((execution) => {
			if (!EMBEDDINGS.test(execution.sql)) return;
			statements++;
		});
		const promise = scanSessionSimilarity(query, { model: "fake-4096", dim: 4096 });
		setImmediate(() => {
			immediateRanAtStatement = statements;
		});
		await promise;
		expect(immediateRanAtStatement).toBe(1);
	});

	test("an event inserted mid-scan is not in the scan's population and nothing throws", async () => {
		const { scanSessionSimilarity } = await import("../ai/embeddings/vector-scan.js");
		const query = seedCorpus({ count: 200, dim: 4096, model: "fake-4096", plantedId: 100 });
		let inserted = false;
		meter.setAfterExecute((execution) => {
			if (!EMBEDDINGS.test(execution.sql) || inserted) return;
			inserted = true;
			seedRows([{ id: 5_000, sessionId: "s-1", model: "fake-4096", dim: 4096, vector: query }]);
		});
		const result = await scanSessionSimilarity(query, { model: "fake-4096", dim: 4096 });
		expect(inserted).toBe(true);
		expect(result.stats.returned).toBe(200);
		expect(result.stats.oldestEventId).toBe(1);
		// the planted match is the only neighbour; the late row (also a perfect match) isn't counted
		expect(result.perSession.get(PLANTED_SESSION)?.count).toBe(1);
		expect(result.perSession.get("s-1")?.count ?? 0).toBe(0);
	});
});

describe("a missing scan index degrades the turn instead of failing it", () => {
	const INDEX = "idx_event_embeddings_model_dim_event";

	beforeEach(() => {
		getSqlite().exec(`DROP INDEX IF EXISTS ${INDEX}`);
	});

	afterEach(() => {
		getSqlite().exec(
			`CREATE INDEX IF NOT EXISTS ${INDEX} ON event_embeddings (model, dim, event_id)`,
		);
	});

	test("the sync and stream turns still answer, with no semantic matches", async () => {
		const query = seedCorpus({ count: 100, dim: 4096, model: "fake-4096", plantedId: 50 });
		useAdapter("fake-4096", 4096, query);

		const sync = await runAskTurn({ message: MESSAGE, actor: ACTOR });
		expect(sync.assistantMessage.content.length).toBeGreaterThan(0);
		expect(sync.includedSessionIds).not.toContain(PLANTED_SESSION);

		let streamedSessions: string[] | null = null;
		let finished = false;
		for await (const event of runAskTurnStream({ message: MESSAGE, actor: ACTOR })) {
			if (event.kind === "start") streamedSessions = event.includedSessionIds;
			if (event.kind === "done") finished = true;
		}
		expect(finished).toBe(true);
		expect(streamedSessions).not.toContain(PLANTED_SESSION);
	});

	test("POST /ai/ask answers 200, not 500, and nothing goes unhandled", async () => {
		const { app } = await import("../../app.js");
		const { createApiKey } = await import("../../auth/api-key.js");
		const query = seedCorpus({ count: 100, dim: 4096, model: "fake-4096", plantedId: 50 });
		useAdapter("fake-4096", 4096, query);
		const { key } = await createApiKey(`outage-ask-${crypto.randomUUID()}`, ["manage"]);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const res = await app.request("/api/v1/ai/ask", {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify({ message: MESSAGE }),
			});
			expect(res.status).toBe(200);
			await nextImmediate();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

// The fake clock is exercised by vector-scan.test.ts; kept importable here for symmetry.
void createFakeClock;
