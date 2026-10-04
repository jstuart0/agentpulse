/**
 * Pins the text an embedding call receives for each event, for every embeddable
 * event type and every shape of payload, on both ways an event gets embedded:
 * the boot backfill and the inline `embedEvent`. It was written against the
 * code that parses the whole payload in JavaScript, and must pass unchanged
 * once the extraction moves into SQL: the same event must reach the model
 * with the same text. A `null` expected text means the event is skipped (a
 * skip marker for the backfill, nothing at all inline).
 *
 * Not pinned here, because the old code differs from the new on purpose:
 * invalid JSON (the old backfill threw), and a character outside the Basic
 * Multilingual Plane across the 3,000 boundary (JavaScript counted UTF-16
 * units, SQL counts characters).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { describeSqliteOnly } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const service = await import("./embedding-service.js");
const { insertEventRow, resetEmbeddingWorld } = await import(
	"../../../test-utils/embedding-fixtures.js"
);

const MODEL = "char-model";
const SYNTHETIC = "Turn completed";
const originalVectorSearch = config.vectorSearchEnabled;

interface Case {
	name: string;
	type?: string;
	content?: string | null;
	payload: string | Record<string, unknown> | unknown[] | number | null;
	/** The text the model should receive, or null when the event is skipped. */
	text: string | null;
}

const repeat = (s: string, n: number) => s.repeat(n);

const OTHER_TYPES = [
	"AssistantMessage",
	"TaskCreated",
	"TaskCompleted",
	"SubagentStop",
	"SessionEnd",
	"AiProposal",
	"AiReport",
	"AiHitlRequest",
];

const CASES: Case[] = [
	{ name: "prompt", payload: { prompt: "hello prompt" }, text: "hello prompt" },
	{
		name: "prompt wins over every other field",
		payload: { prompt: "P", message: "M", summary: "S", why: "W", title: "T" },
		content: "C",
		text: "P",
	},
	{
		name: "message",
		payload: { message: "M", summary: "S", why: "W", title: "T" },
		content: "C",
		text: "M",
	},
	{ name: "summary", payload: { summary: "S", why: "W", title: "T" }, content: "C", text: "S" },
	{ name: "why", payload: { why: "W", title: "T" }, content: "C", text: "W" },
	{ name: "title", payload: { title: "T" }, content: "C", text: "T" },
	{ name: "content when the payload has no text", payload: { other: 1 }, content: "C", text: "C" },
	{ name: "a numeric prompt falls through", payload: { prompt: 5, message: "M" }, text: "M" },
	{
		name: "an object prompt falls through",
		payload: { prompt: { a: 1 }, summary: "S" },
		text: "S",
	},
	{ name: "an array prompt falls through", payload: { prompt: ["x"], title: "T" }, text: "T" },
	{ name: "a null prompt falls through", payload: { prompt: null }, content: "C", text: "C" },
	{ name: "an empty prompt falls through", payload: { prompt: "", message: "M" }, text: "M" },
	{ name: "a boolean message falls through", payload: { message: true, why: "W" }, text: "W" },
	{
		name: "a whitespace-only prompt is the text and is then skipped",
		payload: { prompt: "   ", message: "M" },
		content: "C",
		text: null,
	},
	{ name: "a payload that is a JSON array uses content", payload: [], content: "C", text: "C" },
	{ name: "a payload that is a JSON number uses content", payload: 5, content: "C", text: "C" },
	{ name: "a payload that is JSON null uses content", payload: "null", content: "C", text: "C" },
	{
		name: "a payload that is a JSON string uses content",
		payload: '"just text"',
		content: "C",
		text: "C",
	},
	{ name: "no text anywhere is skipped", payload: {}, content: null, text: null },
	{
		name: "the synthetic Stop marker is skipped",
		type: "Stop",
		payload: {},
		content: SYNTHETIC,
		text: null,
	},
	{
		name: "a Stop with a real message embeds the message",
		type: "Stop",
		payload: { message: "real" },
		content: SYNTHETIC,
		text: "real",
	},
	{
		name: "a Stop whose content is not the marker embeds its content",
		type: "Stop",
		payload: {},
		content: "stop content",
		text: "stop content",
	},
	{
		name: "a non-Stop event whose content is the marker embeds it",
		payload: {},
		content: SYNTHETIC,
		text: SYNTHETIC,
	},
	{
		name: "2,999 characters are kept whole",
		payload: { prompt: repeat("a", 2_999) },
		text: repeat("a", 2_999),
	},
	{
		name: "3,000 characters are kept whole",
		payload: { prompt: repeat("a", 3_000) },
		text: repeat("a", 3_000),
	},
	{
		name: "3,001 characters are cut to 3,000",
		payload: { prompt: repeat("a", 3_001) },
		text: repeat("a", 3_000),
	},
	{
		name: "5,000 characters are cut to 3,000",
		payload: { prompt: repeat("b", 5_000) },
		text: repeat("b", 3_000),
	},
	{
		name: "multibyte BMP text is cut by characters",
		payload: { prompt: repeat("日é", 2_000) },
		text: repeat("日é", 1_500),
	},
	{
		name: "content is cut to 3,000 too",
		payload: {},
		content: repeat("c", 4_000),
		text: repeat("c", 3_000),
	},
	...OTHER_TYPES.map((type) => ({
		name: `${type} embeds its payload text`,
		type,
		payload: { why: `why for ${type}` },
		text: `why for ${type}`,
	})),
];

function seed(): number[] {
	return CASES.map((c) =>
		insertEventRow({
			type: c.type ?? "UserPromptSubmit",
			content: c.content,
			rawPayload: c.payload,
		}),
	);
}

function adapter(texts: string[]) {
	return {
		kind: "ollama" as const,
		model: MODEL,
		dim: 4,
		embed: async (text: string) => {
			texts.push(text);
			return new Float32Array(4).fill(0.1);
		},
	};
}

describeSqliteOnly("the text an embedding call receives", () => {
	beforeAll(async () => {
		await initializeDatabase();
		(config as Record<string, unknown>).vectorSearchEnabled = true;
		service.__setBackfillBackoffForTests(() => 0);
	});
	afterAll(() => {
		(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
		service.__resetEmbeddingAdapterForTests();
	});
	beforeEach(() => {
		resetEmbeddingWorld();
		service.__resetEmbeddingAdapterForTests();
	});

	const expected = CASES.filter((c) => c.text !== null).map((c) => c.text);

	test("the boot backfill sends each embeddable event's text, in id order, and skip-marks the rest", async () => {
		const ids = seed();
		const texts: string[] = [];
		service.__setEmbeddingAdapterForTests(adapter(texts));

		const result = await service.runBackfill();

		expect(result.error).toBeNull();
		expect(texts).toEqual(expected as string[]);
		const dims = new Map(
			(
				getSqlite()
					.prepare("SELECT event_id, dim FROM event_embeddings WHERE model = ?")
					.all(MODEL) as Array<{
					event_id: number;
					dim: number;
				}>
			).map((r) => [r.event_id, r.dim]),
		);
		CASES.forEach((c, i) => {
			expect(dims.get(ids[i] as number), c.name).toBe(c.text === null ? 0 : 4);
		});
	});

	test("the inline embed sends exactly the same text for the same events", async () => {
		const ids = seed();
		const texts: string[] = [];
		service.__setEmbeddingAdapterForTests(adapter(texts));

		for (const id of ids) await service.embedEvent(id);

		expect(texts).toEqual(expected as string[]);
		const embedded = new Set(
			(
				getSqlite().prepare("SELECT event_id FROM event_embeddings").all() as Array<{
					event_id: number;
				}>
			).map((r) => r.event_id),
		);
		CASES.forEach((c, i) => {
			expect(embedded.has(ids[i] as number), c.name).toBe(c.text !== null);
		});
	});

	test("an event type that is not embeddable is never sent, by either route", async () => {
		const id = insertEventRow({ type: "PreToolUse", content: "x", rawPayload: { prompt: "p" } });
		const texts: string[] = [];
		service.__setEmbeddingAdapterForTests(adapter(texts));
		await service.runBackfill();
		await service.embedEvent(id);
		expect(texts).toEqual([]);
		expect(getSqlite().prepare("SELECT COUNT(*) AS n FROM event_embeddings").get()).toEqual({
			n: 0,
		});
	});
});

describe("the fixture itself", () => {
	test("every case has a distinct expectation where it should, so a wrong text cannot hide", () => {
		const texts = CASES.filter((c) => c.text !== null).map((c) => c.text);
		expect(texts.length).toBeGreaterThan(30);
		expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
	});
});
