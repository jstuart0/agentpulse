/**
 * The inline embed runs once per ingested event. It must look at the event's
 * type before it touches the payload or resolves an adapter (most events are
 * not embeddable), and it must add no statement to the hook path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const service = await import("./embedding-service.js");
const { insertEventRow, resetEmbeddingWorld } = await import(
	"../../../test-utils/embedding-fixtures.js"
);
const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");

import type { StatementMeter } from "../../../test-utils/statement-meter.js";

const MODEL = "inline-model";
const MIB = 1_048_576;
const originalVectorSearch = config.vectorSearchEnabled;

let meter: StatementMeter;
let embeds: string[];

function useAdapter(embed?: (text: string) => Promise<Float32Array>) {
	service.__setEmbeddingAdapterForTests({
		kind: "ollama",
		model: MODEL,
		dim: 4,
		embed:
			embed ??
			(async (text: string) => {
				embeds.push(text);
				return new Float32Array(4).fill(0.5);
			}),
	});
}

const row = (id: number) =>
	getSqlite().prepare("SELECT model, dim FROM event_embeddings WHERE event_id = ?").get(id) as {
		model: string;
		dim: number;
	} | null;

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
	resetEmbeddingWorld();
	service.__resetEmbeddingAdapterForTests();
	service.__resetInlineEmbedCountersForTests?.();
	embeds = [];
	meter = installStatementMeter();
});
afterEach(() => {
	if (!isSqliteTest) return;
	meter.restore();
});

describeSqliteOnly("embedEvent", () => {
	test("a non-embeddable event with a 1 MiB payload costs one statement, reads none of the payload, resolves no adapter and embeds nothing", async () => {
		const id = insertEventRow({
			type: "PreToolUse",
			rawPayload: JSON.stringify({ prompt: "p", pad: "x".repeat(MIB) }),
		});
		// no adapter injected: resolving one would read settings and providers
		meter.executions.length = 0;

		await service.embedEvent(id);

		expect(meter.executions.length).toBeLessThanOrEqual(1);
		expect(Math.max(0, ...meter.executions.map((e) => e.chars))).toBeLessThan(1_000);
		expect(embeds).toEqual([]);
		expect(row(id)).toBeNull();
	});

	test("an embeddable event is embedded once with the right text and one upsert; embedding it again replaces the row", async () => {
		const id = insertEventRow({
			type: "UserPromptSubmit",
			rawPayload: { prompt: "what is the plan" },
		});
		useAdapter();
		meter.executions.length = 0;

		await service.embedEvent(id);

		expect(embeds).toEqual(["what is the plan"]);
		expect(row(id)).toEqual({ model: MODEL, dim: 4 });
		expect(meter.matching(/INSERT INTO event_embeddings/).length).toBe(1);

		service.__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: "second-model",
			dim: 8,
			embed: async () => new Float32Array(8),
		});
		await service.embedEvent(id);
		expect(row(id)).toEqual({ model: "second-model", dim: 8 });
		expect(
			(
				getSqlite()
					.prepare("SELECT COUNT(*) AS n FROM event_embeddings WHERE event_id = ?")
					.get(id) as { n: number }
			).n,
		).toBe(1);
	});

	test("a missing event, vector search switched off, no adapter and empty text are silent no-ops that leave the counters alone", async () => {
		const empty = insertEventRow({ type: "UserPromptSubmit", rawPayload: {}, content: null });
		useAdapter();
		await service.embedEvent(987_654);
		await service.embedEvent(empty);

		(config as Record<string, unknown>).vectorSearchEnabled = false;
		const real = insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "p" } });
		await service.embedEvent(real);
		(config as Record<string, unknown>).vectorSearchEnabled = true;

		service.__resetEmbeddingAdapterForTests();
		await service.embedEvent(real);

		expect(embeds).toEqual([]);
		expect(service.getInlineEmbedCounters()).toEqual({ ok: 0, failed: 0 });
		expect(row(real)).toBeNull();
	});

	test("successes and failures are counted and a failure is swallowed", async () => {
		const a = insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "a" } });
		const b = insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "b" } });
		useAdapter();
		await service.embedEvent(a);
		expect(service.getInlineEmbedCounters()).toEqual({ ok: 1, failed: 0 });

		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			useAdapter(async () => {
				throw new Error("embedding server down");
			});
			await expect(service.embedEvent(b)).resolves.toBeUndefined();
		} finally {
			warn.mockRestore();
		}
		expect(service.getInlineEmbedCounters()).toEqual({ ok: 1, failed: 1 });
		expect(row(b)).toBeNull();
	});

	test("an embeddable event adds no statement beyond its one read and one upsert", async () => {
		const id = insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: "p" } });
		useAdapter();
		meter.executions.length = 0;
		await service.embedEvent(id);
		expect(meter.executions.length).toBeLessThanOrEqual(2);
	});
});
