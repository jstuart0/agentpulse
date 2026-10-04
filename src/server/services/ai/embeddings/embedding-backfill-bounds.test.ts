/**
 * The boot backfill must not hold or parse memory in proportion to payload
 * sizes, must not re-walk what is already embedded, and must not stop early
 * where ids have gaps. A hook payload can be 16 MiB, so what a statement
 * returns and what SQLite is asked to parse are bounded:
 *
 *  - stage one reads ids and `octet_length(raw_payload)` only, inside an id
 *    window above a cursor;
 *  - stage two extracts text in SQL for the longest prefix of those rows whose
 *    payloads sum to at most 4 MiB (always at least one row), and only parses a
 *    payload that is itself at most 4 MiB;
 *  - an empty window advances the cursor instead of ending the run.
 *
 * Bun exposes no memory or VM-step counter, so "parsed" is shown through
 * outcomes (a payload over the cap contributes no text) and a structural check
 * that every JSON function sits behind the size guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const service = await import("./embedding-service.js");
const { insertEventRow, resetEmbeddingWorld } = await import(
	"../../../test-utils/embedding-fixtures.js"
);
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");
const { startTicker } = await import("../../../test-utils/ticker.js");

import type { StatementExecution, StatementMeter } from "../../../test-utils/statement-meter.js";

const MODEL = "bounds-model";
const MIB = 1_048_576;
const STAGE_ONE = /octet_length\(e\.raw_payload\)/;
const STAGE_TWO = /json_valid/;
const BATCH_SELECT = /^\s*SELECT[\s\S]*FROM events e\b/i;
const originalVectorSearch = config.vectorSearchEnabled;

let meter: StatementMeter;
let texts: string[];

function useAdapter(
	opts: {
		embed?: (text: string) => Promise<Float32Array>;
	} = {},
) {
	service.__setEmbeddingAdapterForTests({
		kind: "ollama",
		model: MODEL,
		dim: 4,
		embed:
			opts.embed ??
			(async (text: string) => {
				texts.push(text);
				return new Float32Array(4).fill(0.1);
			}),
	});
}

/** A JSON object payload of exactly `bytes` bytes carrying `prompt` and padding. */
function payloadOfSize(bytes: number, prompt = "short"): string {
	const head = JSON.stringify({ prompt, pad: "" });
	return JSON.stringify({ prompt, pad: "x".repeat(bytes - head.length) });
}

function embeddedIds(): number[] {
	return (
		getSqlite()
			.prepare(
				"SELECT event_id FROM event_embeddings WHERE model = ? AND dim = 4 ORDER BY event_id",
			)
			.all(MODEL) as Array<{ event_id: number }>
	).map((r) => r.event_id);
}

function logLines() {
	const lines: Array<Record<string, unknown>> = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		if (typeof args[0] !== "string") return;
		try {
			lines.push(JSON.parse(args[0]));
		} catch {
			// not structured
		}
	});
	return { lines, restore: () => spy.mockRestore() };
}

const stageOnes = () => meter.matching(STAGE_ONE);
const stageTwos = () => meter.matching(STAGE_TWO);

beforeAll(async () => {
	if (!isSqliteTest) return;
	await initializeDatabase();
	(config as Record<string, unknown>).vectorSearchEnabled = true;
	service.__setBackfillBackoffForTests(() => 0);
});
afterAll(() => {
	if (!isSqliteTest) return;
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	service.__resetEmbeddingAdapterForTests();
});
beforeEach(() => {
	if (!isSqliteTest) return;
	resetEmbeddingWorld();
	service.__resetEmbeddingAdapterForTests();
	texts = [];
	meter = installStatementMeter();
});

import { afterEach } from "bun:test";
afterEach(() => {
	if (!isSqliteTest) return;
	meter.restore();
});

describeSqliteOnly("a batch of large payloads", () => {
	test("40 pending events with 1 MiB payloads: no statement returns more than 200,000 characters, and none returns raw_payload", async () => {
		for (let i = 0; i < 40; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: payloadOfSize(MIB) });
		useAdapter();

		const result = await service.runBackfill();

		expect(result.error).toBeNull();
		const selects = meter.matching(BATCH_SELECT);
		expect(selects.length).toBeGreaterThan(0);
		expect(Math.max(...selects.map((s) => s.chars))).toBeLessThan(200_000);
		expect(selects.some((s) => /\braw_payload\s+AS\s+rawPayload\b/i.test(s.sql))).toBe(false);
	});

	test("those 40 are embedded with the text 'short'", async () => {
		for (let i = 0; i < 40; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: payloadOfSize(MIB) });
		useAdapter();
		await service.runBackfill();
		expect(texts).toEqual(Array(40).fill("short"));
	});

	test("stage one returns ids and integer sizes only", async () => {
		for (let i = 0; i < 5; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: payloadOfSize(1_000) });
		useAdapter();
		await service.runBackfill();
		const ones = stageOnes();
		expect(ones.length).toBeGreaterThan(0);
		for (const one of ones) {
			expect(one.chars).toBe(0);
			expect(one.bytes).toBe(0);
			expect(one.sql).not.toMatch(/\bcontent\b/);
		}
	});

	test("a batch is capped by bytes: four 1 MiB rows share a stage-two read, three when each is one byte over", async () => {
		for (let i = 0; i < 8; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: payloadOfSize(MIB) });
		useAdapter();
		await service.runBackfill();
		expect(stageTwos().map((s) => s.rows)).toEqual([4, 4]);

		resetEmbeddingWorld();
		texts.length = 0;
		meter.executions.length = 0;
		for (let i = 0; i < 8; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: payloadOfSize(MIB + 1) });
		await service.runBackfill();
		expect(stageTwos().map((s) => s.rows)).toEqual([3, 3, 2]);
	});

	test("a row larger than the whole budget is read alone, and a table of them terminates", async () => {
		for (let i = 0; i < 3; i++)
			insertEventRow({
				type: "UserPromptSubmit",
				rawPayload: payloadOfSize(5 * MIB),
				content: `c${i}`,
			});
		useAdapter();
		const result = await service.runBackfill();
		expect(result.error).toBeNull();
		expect(stageTwos().map((s) => s.rows)).toEqual([1, 1, 1]);
		expect(embeddedIds().length).toBe(3);
	});

	test("a payload over the 4 MiB parse cap contributes no text: the embed text comes from content", async () => {
		insertEventRow({
			type: "UserPromptSubmit",
			content: "from content",
			rawPayload: payloadOfSize(5 * MIB, "SENTINEL from the payload"),
		});
		insertEventRow({
			type: "UserPromptSubmit",
			content: "ignored",
			rawPayload: payloadOfSize(4 * MIB, "inside the cap"),
		});
		useAdapter();
		await service.runBackfill();
		expect(texts).toEqual(["from content", "inside the cap"]);
	});

	test("every statement that parses JSON sits behind an octet_length(raw_payload) <= guard", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./embedding-service.ts", import.meta.url), "utf8");
		const literals = source.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) ?? [];
		const parsing = literals.filter((l) => /json_valid|json_extract|json_type/.test(l));
		expect(parsing.length).toBeGreaterThan(0);
		for (const statement of parsing) expect(statement).toMatch(/octet_length\(raw_payload\)\s*<=/);
	});
});

describeSqliteOnly("the cursor and the id window", () => {
	test("5,000 embedded events ahead of 40 pending: exactly the 40 are embedded, the cursor only moves forward, and the loop yields between windows", async () => {
		const sqlite = getSqlite();
		useAdapter();
		sqlite.transaction(() => {
			for (let i = 0; i < 5_000; i++) {
				const id = insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `old ${i}` } });
				sqlite
					.prepare(
						"INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, ?, 4, ?)",
					)
					.run(id, MODEL, new Uint8Array(16));
			}
		})();
		for (let i = 0; i < 40; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `new ${i}` } });
		meter.executions.length = 0;

		const ticker = startTicker();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const ticksAt: number[] = [];
		meter.setAfterExecute((e: StatementExecution) => {
			if (STAGE_ONE.test(e.sql)) ticksAt.push(ticker.ticks);
		});
		await service.runBackfill();
		ticker.stop();

		expect(texts.length).toBe(40);
		const cursors = stageOnes().map((s) => s.params.find((p) => typeof p === "number") as number);
		expect(cursors.length).toBeGreaterThan(1);
		for (let i = 1; i < cursors.length; i++) {
			expect(cursors[i]).toBeGreaterThanOrEqual(cursors[i - 1] as number);
		}
		expect(cursors[cursors.length - 1]).toBeGreaterThan(cursors[0] as number);
		for (let i = 1; i < ticksAt.length; i++) {
			expect(ticksAt[i]).toBeGreaterThan(ticksAt[i - 1] as number);
		}
	}, 30_000);

	test("an empty window advances instead of ending the run: gaps of window-1, window, window+1 and 20,000", async () => {
		const window = service.BACKFILL_ID_WINDOW;
		expect(window).toBe(5_000);
		useAdapter();
		let id = 0;
		const ids: number[] = [];
		const put = (at: number) => {
			ids.push(
				insertEventRow({ id: at, type: "UserPromptSubmit", rawPayload: { prompt: `at ${at}` } }),
			);
			id = at;
		};
		for (let i = 1; i <= 10; i++) put(i);
		for (const gap of [window - 1, window, window + 1, 20_000]) {
			put(id + gap + 1);
		}
		put(id + 1);

		const result = await service.runBackfill();

		expect(result.error).toBeNull();
		expect(embeddedIds()).toEqual(ids);
		expect(result.running).toBe(false);
	}, 30_000);

	test("an empty events table ends after one pass", async () => {
		useAdapter();
		const result = await service.runBackfill();
		expect(result.error).toBeNull();
		expect(stageOnes().length).toBeLessThanOrEqual(1);
		expect(texts).toEqual([]);
	});

	test("events inserted while the run is going are embedded before it ends", async () => {
		for (let i = 0; i < 40; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `first ${i}` } });
		let injected = false;
		useAdapter({
			embed: async (text: string) => {
				texts.push(text);
				if (!injected) {
					injected = true;
					insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "late one" } });
					insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "late two" } });
				}
				return new Float32Array(4).fill(0.1);
			},
		});
		await service.runBackfill();
		expect(texts).toContain("late one");
		expect(texts).toContain("late two");
		expect(embeddedIds().length).toBe(42);
	});
});

describeSqliteOnly("what the loop selects and how it fails", () => {
	test("a batch is at most 32 rows, only embeddable types are selected, embedded rows are skipped and rows under another model are re-embedded", async () => {
		const sqlite = getSqlite();
		for (let i = 0; i < 70; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `row ${i}` } });
		insertEventRow({ type: "PreToolUse", rawPayload: { prompt: "tool" } });
		const first = Number(
			(sqlite.prepare("SELECT MIN(id) AS m FROM events").get() as { m: number }).m,
		);
		sqlite
			.prepare("INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, ?, 4, ?)")
			.run(first, MODEL, new Uint8Array(16));
		sqlite
			.prepare(
				"INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, 'other-model', 4, ?)",
			)
			.run(first + 1, new Uint8Array(16));
		useAdapter();

		await service.runBackfill();

		expect(texts.length).toBe(69);
		expect(texts).not.toContain("row 0");
		expect(texts).toContain("row 1");
		expect(texts).not.toContain("tool");
		for (const s of stageTwos()) expect(s.rows).toBeLessThanOrEqual(32);
	});

	test("a failing embed leaves the cursor in place, the circuit opens after five failures, and after recovery the same rows embed", async () => {
		for (let i = 0; i < 5; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `row ${i}` } });
		let down = true;
		useAdapter({
			embed: async (text: string) => {
				if (down) throw new Error("embedding server down");
				texts.push(text);
				return new Float32Array(4).fill(0.1);
			},
		});
		const opened = await service.runBackfill();
		expect(opened.error).toMatch(/circuit open/);
		expect(embeddedIds()).toEqual([]);

		down = false;
		const recovered = await service.runBackfill();
		expect(recovered.error).toBeNull();
		expect(embeddedIds().length).toBe(5);
	});

	test("a permanently failing row is today's behaviour: rows before it embed, the circuit opens, rows behind it wait, and the next run stops at the same place", async () => {
		for (let i = 0; i < 32; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `before ${i}` } });
		insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "POISON" } });
		for (let i = 0; i < 3; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `behind ${i}` } });
		useAdapter({
			embed: async (text: string) => {
				if (text.includes("POISON")) throw new Error("cannot embed");
				texts.push(text);
				return new Float32Array(4).fill(0.1);
			},
		});

		const first = await service.runBackfill();
		expect(first.error).toMatch(/circuit open/);
		const afterFirst = embeddedIds();
		expect(afterFirst.length).toBe(32);

		const second = await service.runBackfill();
		expect(second.error).toMatch(/circuit open/);
		expect(embeddedIds()).toEqual(afterFirst);
	});

	test("skip-marked rows advance the cursor, and a batch of nothing but skips terminates", async () => {
		for (let i = 0; i < 70; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: {}, content: null });
		useAdapter();
		const result = await service.runBackfill();
		expect(result.error).toBeNull();
		expect(texts).toEqual([]);
		expect(
			(
				getSqlite().prepare("SELECT COUNT(*) AS n FROM event_embeddings WHERE dim = 0").get() as {
					n: number;
				}
			).n,
		).toBe(70);
	});

	test("progress is right with gaps and with rows that fail", async () => {
		for (let i = 0; i < 5; i++)
			insertEventRow({ id: 1 + i, type: "UserPromptSubmit", rawPayload: { prompt: `a ${i}` } });
		for (let i = 0; i < 5; i++)
			insertEventRow({ id: 9_001 + i, type: "UserPromptSubmit", rawPayload: { prompt: `b ${i}` } });
		useAdapter();
		const done = await service.runBackfill();
		expect(done).toMatchObject({ total: 10, embedded: 10, pending: 0, running: false });
		const progress = await service.getBackfillProgress();
		expect(progress).toMatchObject({ total: 10, embedded: 10, pending: 0 });

		resetEmbeddingWorld();
		for (let i = 0; i < 4; i++)
			insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `x ${i}` } });
		useAdapter({
			embed: async () => {
				throw new Error("down");
			},
		});
		const failed = await service.runBackfill();
		expect(failed).toMatchObject({ total: 4, embedded: 0 });
		expect(await service.getBackfillProgress()).toMatchObject({
			total: 4,
			embedded: 0,
			pending: 4,
		});
	});
});

describeSqliteOnly("text edge cases the old code could not handle", () => {
	test("invalid JSON, an empty payload and a missing-field payload fall back to content, and the rest of the batch embeds", async () => {
		insertEventRow({
			type: "UserPromptSubmit",
			content: "bad json content",
			rawPayload: "{not json",
		});
		insertEventRow({ type: "UserPromptSubmit", content: "empty content", rawPayload: "" });
		insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "fine" } });
		useAdapter();

		const result = await service.runBackfill();

		expect(result.error).toBeNull();
		expect(texts).toEqual(["bad json content", "empty content", "fine"]);
	});

	test("an astral character across the 3,000 boundary is cut by character in SQL, not by UTF-16 unit", async () => {
		const prompt = `${"a".repeat(2_999)}😀tail`;
		insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt } });
		useAdapter();
		await service.runBackfill();
		expect(texts).toEqual([`${"a".repeat(2_999)}😀`]);
	});
});

describeSqliteOnly("logging", () => {
	test("embedding_backfill_batch_started is logged before the embed call with the cursor, row count and payload bytes, and no text", async () => {
		insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "secret question text" } });
		const logs = logLines();
		let startedBeforeEmbed = false;
		useAdapter({
			embed: async () => {
				startedBeforeEmbed = logs.lines.some((l) => l.kind === "embedding_backfill_batch_started");
				return new Float32Array(4).fill(0.1);
			},
		});
		try {
			await service.runBackfill();
		} finally {
			logs.restore();
		}
		expect(startedBeforeEmbed).toBe(true);
		const started = logs.lines.find((l) => l.kind === "embedding_backfill_batch_started");
		expect(started).toMatchObject({ rows: 1 });
		expect(typeof started?.cursor).toBe("number");
		expect(typeof started?.payloadBytes).toBe("number");
		expect(JSON.stringify(logs.lines)).not.toContain("secret question text");
	});
});

describe("test file sanity", () => {
	test("payloadOfSize produces exactly the requested size", () => {
		expect(Buffer.byteLength(payloadOfSize(MIB))).toBe(MIB);
		expect(Buffer.byteLength(payloadOfSize(MIB + 1))).toBe(MIB + 1);
	});
});
