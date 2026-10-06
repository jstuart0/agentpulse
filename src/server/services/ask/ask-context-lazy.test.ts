/**
 * Semantic enrichment (embedding the query, then the vector scan) belongs to
 * the one place its output is consumed: the free-form LLM fall-through. Every
 * turn that a gate or an intercept handles must run no embed call, no scan
 * statement and no term-expander call; a turn bounded to what it uses reads
 * the last 12 messages, not the thread; a message over the cap is refused
 * before anything is written or computed.
 *
 * Work is measured, not read: the statement meter sees every raw statement,
 * the fake adapter counts embeds, and the scripted LLM tells classifier,
 * expander and answer calls apart. The replies themselves are pinned in
 * `ask-turn-characterisation.test.ts`.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { describeSqliteOnly } from "../../test-utils/backend.js";
import "../ai/__test_db.js";

const llm = await import("../../test-utils/scripted-llm.js");
// mock.module replaces the module for the whole process and is not undone when the file ends;
// keep the real registry and put it back in afterAll (AGEN-69 P2-26).
const REGISTRY_PATH = "../ai/llm/registry.js";
const realRegistry = { ...(await import("../ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { config } = await import("../../config.js");
const { getDb, getSqlite } = await import("../../db/client.js");
const {
	ASK_ACTOR,
	EMBED_DIM,
	EMBED_MODEL,
	embedCalls,
	resetAskWorld,
	setupAskFixture,
	teardownAskFixture,
} = await import("../../test-utils/ask-turn-fixture.js");
const { __setEmbeddingAdapterForTests } = await import("../ai/embeddings/embedding-service.js");
const { invalidateAiFlagsCache } = await import("../ai/feature.js");
const cases = await import("../../test-utils/ask-turn-cases.js");
const { installStatementMeter } = await import("../../test-utils/statement-meter.js");
const service = await import("./ask-service.js");

import type { GateCase } from "../../test-utils/ask-turn-cases.js";
import type { StatementMeter } from "../../test-utils/statement-meter.js";

const SCAN_SELECT = /SELECT[\s\S]*FROM event_embeddings v/;
/** The history read: a drizzle select from ask_messages (not this file's own COUNT queries). */
const MESSAGE_SELECT = /^\s*select\s+(?!count\()[\s\S]*from\s+"ask_messages"/i;

interface Work {
	embeds: number;
	scanStatements: number;
	scanLogs: number;
	classifierCalls: number;
	expanderCalls: number;
	answerCalls: number;
	messageSelects: number;
	userRows: number;
	reply: string;
}

let meter: StatementMeter;
const table: Array<{ case: string; path: string } & Work> = [];

function logKinds(): { kinds: string[]; restore: () => void } {
	const kinds: string[] = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		if (typeof args[0] !== "string") return;
		try {
			const kind = (JSON.parse(args[0]) as { kind?: string }).kind;
			if (kind) kinds.push(kind);
		} catch {
			// not a structured line
		}
	});
	return { kinds, restore: () => spy.mockRestore() };
}

async function measure(c: GateCase, path: "sync" | "stream", rowName = c.name): Promise<Work> {
	cases.applyScript(c);
	const logs = logKinds();
	let outcome: Awaited<ReturnType<typeof cases.runSync>>;
	try {
		outcome = await (path === "sync" ? cases.runSync : cases.runStream)(cases.inputFor(c));
	} finally {
		logs.restore();
	}
	const work: Work = {
		embeds: embedCalls.length,
		scanStatements: meter.matching(SCAN_SELECT).length,
		scanLogs: logs.kinds.filter((k) => k === "ask_vector_scan_started").length,
		classifierCalls: llm.callsOfKind("classifier").length,
		expanderCalls: llm.callsOfKind("expander").length,
		answerCalls: llm.callsOfKind("answer").length,
		messageSelects: meter.matching(MESSAGE_SELECT).length,
		userRows: (
			getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_messages WHERE role = 'user'").get() as {
				n: number;
			}
		).n,
		reply: outcome.reply,
	};
	table.push({ case: rowName, path, ...work });
	return work;
}

beforeAll(async () => {
	if (!isSqlite()) return;
	await setupAskFixture();
});
afterAll(() => {
	mock.module(REGISTRY_PATH, () => realRegistry);
	if (!isSqlite()) return;
	teardownAskFixture();
	if (process.env.ASK_PRINT_TABLE) {
		for (const row of table) console.log(`INTENT_TABLE ${JSON.stringify(row)}`);
	}
});
beforeEach(async () => {
	if (!isSqlite()) return;
	await resetAskWorld();
	meter = installStatementMeter();
});
afterEach(() => {
	if (!isSqlite()) return;
	meter.restore();
});

function isSqlite(): boolean {
	return config.dialect === "sqlite";
}

describeSqliteOnly("a turn that a gate or an intercept handles does no semantic work", () => {
	for (const c of cases.HANDLED_CASES) {
		for (const path of ["sync", "stream"] as const) {
			test(`${c.name} (${path}): no embed, no scan statement, no term expander, no message-history read; the user message is saved once`, async () => {
				const work = await measure(c, path);
				expect(work.embeds).toBe(0);
				expect(work.scanStatements).toBe(0);
				expect(work.scanLogs).toBe(0);
				expect(work.expanderCalls).toBe(0);
				expect(work.answerCalls).toBe(0);
				expect(work.messageSelects).toBe(0);
				expect(work.userRows).toBe(1);
			});
		}
	}

	test("every intent gate has a case here, so a new gate cannot be added unmeasured", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./ask-service.ts", import.meta.url), "utf8");
		expect((source.match(/^\s*defineGate</gm) ?? []).length).toBe(cases.GATE_CASE_COUNT);
	});
});

describeSqliteOnly("a turn that reaches the free-form answer pays for one bounded scan", () => {
	for (const path of ["sync", "stream"] as const) {
		test(`a greeting matching no gate (${path}): one embed, one scan, one term expander, one answer`, async () => {
			const c = cases.FALLTHROUGH_CASES[0] as GateCase;
			const work = await measure(c, path);
			expect(work.embeds).toBe(1);
			expect(work.scanLogs).toBe(1);
			expect(work.scanStatements).toBeGreaterThan(0);
			expect(work.scanStatements).toBeLessThanOrEqual(2);
			expect(work.expanderCalls).toBe(1);
			expect(work.answerCalls).toBe(1);
			expect(work.messageSelects).toBe(1);
			expect(work.userRows).toBe(1);
		});

		test(`a gate that passes but whose classifier declines (${path}) is a fall-through and pays the same one scan`, async () => {
			const c = cases.FALLTHROUGH_CASES[1] as GateCase;
			const work = await measure(c, path);
			expect(work.embeds).toBe(1);
			expect(work.scanLogs).toBe(1);
			expect(work.classifierCalls).toBeGreaterThan(0);
			expect(work.answerCalls).toBe(1);
		});

		test(`explicit session ids (${path}): no enricher at all, and the supplied session is reported`, async () => {
			const c = cases.FALLTHROUGH_CASES[2] as GateCase;
			const work = await measure(c, path);
			expect(work.embeds).toBe(0);
			expect(work.scanStatements).toBe(0);
			expect(work.expanderCalls).toBe(0);
			expect(work.answerCalls).toBe(1);
		});
	}

	test("a search that finds nothing falls through and then pays the one scan", async () => {
		getSqlite().exec("DELETE FROM events");
		const c: GateCase = {
			name: "natural-language search, no hits",
			message: "find session about zebras",
			script: [],
		};
		const work = await measure(c, "sync");
		expect(work.answerCalls).toBe(1);
		expect(work.embeds).toBe(1);
		expect(work.scanLogs).toBe(1);
	});

	test("the embedding adapter failing still ends in a saved assistant reply and no scan statement", async () => {
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: EMBED_MODEL,
			dim: EMBED_DIM,
			embed: async () => {
				throw new Error("embedding server down");
			},
		});
		const c = cases.FALLTHROUGH_CASES[0] as GateCase;
		const work = await measure(c, "sync");
		expect(work.reply).toBe("ANSWER");
		expect(work.scanStatements).toBe(0);
		expect(work.answerCalls).toBe(1);
	});

	test("with vector search switched off there is no embed and no scan, and the term expander still runs", async () => {
		getSqlite()
			.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
			.run("vectorSearch.enabled", "false");
		invalidateAiFlagsCache();
		try {
			const work = await measure(cases.FALLTHROUGH_CASES[0] as GateCase, "sync");
			expect(work.embeds).toBe(0);
			expect(work.scanStatements).toBe(0);
			expect(work.expanderCalls).toBe(1);
			expect(work.answerCalls).toBe(1);
		} finally {
			getSqlite()
				.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
				.run("vectorSearch.enabled", "true");
			invalidateAiFlagsCache();
		}
	});
});

describeSqliteOnly("the two paths agree", () => {
	test("the stream's start event reports the same sessions as the sync turn, and the user row is saved before it", async () => {
		const c = cases.FALLTHROUGH_CASES[0] as GateCase;
		cases.applyScript(c);
		const sync = await cases.runSync(cases.inputFor(c));

		await resetAskWorld();
		cases.applyScript(c);
		let userRowsAtStart = -1;
		let startIds: string[] = [];
		for await (const event of service.runAskTurnStream(cases.inputFor(c))) {
			if (event.kind === "start") {
				startIds = event.includedSessionIds;
				userRowsAtStart = (
					getSqlite()
						.prepare("SELECT COUNT(*) AS n FROM ask_messages WHERE role = 'user'")
						.get() as {
						n: number;
					}
				).n;
			}
		}
		expect(startIds).toEqual(sync.included);
		expect(startIds.length).toBeGreaterThan(0);
		expect(userRowsAtStart).toBe(1);
	});

	test("an error while building the context leaves the same saved rows and the same error on both paths", async () => {
		const c = cases.FALLTHROUGH_CASES[0] as GateCase;
		const db = getDb();
		const realSelect = db.select.bind(db);
		const failing = spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
			if (fields && "displayName" in fields && "lastActivityAt" in fields) {
				throw new Error("context store unavailable");
			}
			return realSelect(fields as never);
		}) as never);
		const state = () =>
			getSqlite().prepare("SELECT role FROM ask_messages ORDER BY rowid").all() as Array<{
				role: string;
			}>;
		try {
			cases.applyScript(c);
			await expect(cases.runSync(cases.inputFor(c))).rejects.toThrow("context store unavailable");
			const afterSync = state();
			await resetAskWorld();
			cases.applyScript(c);
			await expect(cases.runStream(cases.inputFor(c))).rejects.toThrow("context store unavailable");
			expect(state()).toEqual(afterSync);
			expect(afterSync).toEqual([{ role: "user" }]);
		} finally {
			failing.mockRestore();
		}
	});

	test("the origin check and thread creation come before any gate, embed or LLM call", async () => {
		getSqlite().exec(
			"INSERT INTO ask_threads (id, title, origin) VALUES ('t-tg', 'from telegram', 'telegram')",
		);
		await expect(
			service.runAskTurn({
				message: "hello there",
				threadId: "t-tg",
				origin: "web",
				actor: ASK_ACTOR,
			}),
		).rejects.toThrow(/telegram-only/);
		expect(embedCalls.length).toBe(0);
		expect(llm.llmCalls.length).toBe(0);
		expect(
			(getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_messages").get() as { n: number }).n,
		).toBe(0);
	});
});

function seedThread(count: number, opts: { sameSecond: boolean }): string[] {
	const sqlite = getSqlite();
	sqlite.exec(
		"INSERT INTO ask_threads (id, title, origin) VALUES ('t-long', 'long thread', 'web')",
	);
	const insert = sqlite.prepare(
		"INSERT INTO ask_messages (id, thread_id, role, content, created_at) VALUES (?, 't-long', ?, ?, ?)",
	);
	const contents: string[] = [];
	sqlite.transaction(() => {
		for (let i = 0; i < count; i++) {
			// Ids run backwards in lexicographic order, so only insertion order recovers the sequence.
			const id = `m-${String(99_999 - i).padStart(5, "0")}`;
			const role = i % 2 === 0 ? "user" : "assistant";
			const created = opts.sameSecond
				? "2026-01-01 00:00:00"
				: `2026-01-01 ${String(Math.floor(i / 3600)).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
			contents.push(`${role}:${i}`);
			insert.run(id, role, `message ${i}`, created);
		}
	})();
	return contents;
}

function expectedHistory(count: number): string {
	// The turn's own user message is saved first, so it is the newest of the 12.
	const lines = ["<history>"];
	for (let i = Math.max(0, count - 11); i < count; i++) {
		lines.push(`${i % 2 === 0 ? "USER" : "ASSISTANT"}: message ${i}`);
	}
	lines.push("USER: hello there caching", "</history>");
	return lines.join("\n");
}

describeSqliteOnly("the history a turn reads is bounded to what it renders", () => {
	for (const [count, sameSecond] of [
		[14, true],
		[500, false],
	] as const) {
		test(`a ${count}-message thread${sameSecond ? " written in one second" : ""}: one history read of at most 12 rows, and the rendered history is the last 12 in order`, async () => {
			seedThread(count, { sameSecond });
			const c: GateCase = {
				name: `history ${count}`,
				message: "hello there caching",
				script: [],
				input: { threadId: "t-long" },
			};
			const logs = logKinds();
			try {
				await measure(c, "sync");
			} finally {
				logs.restore();
			}

			const reads = meter.matching(MESSAGE_SELECT);
			expect(reads.length).toBe(1);
			expect(reads[0]?.sql).toMatch(/limit/i);
			expect(reads[0]?.rows).toBeLessThanOrEqual(12);
			const transcript = llm.callsOfKind("answer")[0]?.transcriptPrompt ?? "";
			const history = transcript.slice(0, transcript.indexOf("</history>") + "</history>".length);
			expect(history).toBe(expectedHistory(count));
		});
	}

	test("the dashboard's own read of a thread still returns every message", async () => {
		seedThread(14, { sameSecond: true });
		const all = await service.listMessages("t-long");
		expect(all.length).toBe(14);
		expect(all.map((m) => m.content)).toEqual(Array.from({ length: 14 }, (_, i) => `message ${i}`));
	});
});

describeSqliteOnly(
	"a message over the cap is refused before anything is written or computed",
	() => {
		const counts = () => ({
			threads: (getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_threads").get() as { n: number })
				.n,
			messages: (
				getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_messages").get() as { n: number }
			).n,
		});

		test("the cap is 8,000 UTF-16 code units: 8,000 is answered, 8,001 is refused with a typed error", async () => {
			expect(service.ASK_MESSAGE_MAX_CHARS).toBe(8_000);
			const ok = await service.runAskTurn({ message: "a".repeat(8_000), actor: ASK_ACTOR });
			expect(ok.assistantMessage.content).toBe("ANSWER");

			await resetAskWorld();
			const refused = service.runAskTurn({ message: "a".repeat(8_001), actor: ASK_ACTOR });
			await expect(refused).rejects.toBeInstanceOf(service.AskMessageTooLongError);
			await expect(refused).rejects.toMatchObject({ max: 8_000 });
			expect(counts()).toEqual({ threads: 0, messages: 0 });
			expect(embedCalls.length).toBe(0);
			expect(llm.llmCalls.length).toBe(0);
		});

		test("the cap counts code units, not code points: 4,000 astral characters are 8,000 units, 4,001 are over", async () => {
			const ok = await service.runAskTurn({ message: "😀".repeat(4_000), actor: ASK_ACTOR });
			expect(ok.assistantMessage.content).toBe("ANSWER");
			await resetAskWorld();
			await expect(
				service.runAskTurn({ message: "😀".repeat(4_001), actor: ASK_ACTOR }),
			).rejects.toBeInstanceOf(service.AskMessageTooLongError);
			expect(counts()).toEqual({ threads: 0, messages: 0 });
		});

		test("the cap applies to the trimmed message", async () => {
			const padded = `   ${"a".repeat(8_000)}   `;
			const ok = await service.runAskTurn({ message: padded, actor: ASK_ACTOR });
			expect(ok.assistantMessage.content).toBe("ANSWER");
		});

		test("the stream refuses before it yields anything", async () => {
			const events: string[] = [];
			await expect(
				(async () => {
					for await (const event of service.runAskTurnStream({
						message: "a".repeat(8_001),
						actor: ASK_ACTOR,
					})) {
						events.push(event.kind);
					}
				})(),
			).rejects.toBeInstanceOf(service.AskMessageTooLongError);
			expect(events).toEqual([]);
			expect(counts()).toEqual({ threads: 0, messages: 0 });
		});

		for (const route of ["/api/v1/ai/ask", "/api/v1/ai/ask/stream"]) {
			test(`POST ${route} answers 400 message_too_long with the cap, and saves nothing`, async () => {
				const { app } = await import("../../app.js");
				const { createApiKey } = await import("../../auth/api-key.js");
				const { key } = await createApiKey(`cap-${crypto.randomUUID()}`, ["manage"]);
				const post = (message: string) =>
					app.request(route, {
						method: "POST",
						headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
						body: JSON.stringify({ message }),
					});

				const res = await post("a".repeat(8_001));
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "message_too_long", max: 8_000 });
				expect(counts()).toEqual({ threads: 0, messages: 0 });
				expect(embedCalls.length).toBe(0);

				const ok = await post("a".repeat(8_000));
				expect(ok.status).toBe(200);
				await ok.text();
			});
		}

		test("Telegram: an enrolled chat sending a message over the cap gets the fixed reply and no turn starts", async () => {
			const { ASK_TOO_LONG_REPLY } = await import("../channels/telegram-replies.js");
			const { createPendingChannel, completeEnrollment } = await import(
				"../channels/channels-service.js"
			);
			const { handleTelegramUpdate } = await import("../../routes/channels.js");
			getSqlite().exec("DELETE FROM notification_channels");
			const { channel } = await createPendingChannel({ kind: "telegram", label: "cap test" });
			await completeEnrollment({ channelId: channel.id, chatId: "4242" });
			// The credentials cache is process-wide and may hold another test's state.
			const credentials = await import("../channels/telegram-credentials.js");
			await credentials.clearTelegramCredentials();
			(config as Record<string, unknown>).telegramBotToken = "test-token";
			await credentials.refreshTelegramCredentials();
			const sent: Array<{ url: string; body: { text?: string } }> = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (url: string, init?: RequestInit) => {
				sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
				return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
			}) as typeof fetch;
			try {
				await handleTelegramUpdate({
					update_id: 1,
					message: { message_id: 1, chat: { id: 4242 }, text: "a".repeat(8_001) },
				} as never);
			} finally {
				globalThis.fetch = realFetch;
				(config as Record<string, unknown>).telegramBotToken = "";
			}
			const messages = sent.filter((s) => s.url.endsWith("/sendMessage")).map((s) => s.body.text);
			expect(messages).toEqual([ASK_TOO_LONG_REPLY]);
			expect(counts()).toEqual({ threads: 0, messages: 0 });
			expect(embedCalls.length).toBe(0);
			expect(llm.llmCalls.length).toBe(0);
		});
	},
);

describe("test file sanity", () => {
	test("the intent table has a row for every handled case on both paths once the suite has run", () => {
		expect(cases.HANDLED_CASES.length).toBe(12);
	});
});
