/**
 * AGEN-79: how an Ask turn is routed and what a follow-up carries over.
 * Whole turns through the scripted LLM and the shared Ask fixture, so the
 * routing decision is asserted on what the user reads, not on a helper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { describeSqliteOnly } from "../../test-utils/backend.js";
import "../ai/__test_db.js";

const llm = await import("../../test-utils/scripted-llm.js");
const REGISTRY_PATH = "../ai/llm/registry.js";
const realRegistry = { ...(await import("../ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { getSqlite } = await import("../../db/client.js");
const { resetAskWorld, setupAskFixture, teardownAskFixture } = await import(
	"../../test-utils/ask-turn-fixture.js"
);
const { inputFor, runSync } = await import("../../test-utils/ask-turn-cases.js");
const { ASK_ACTOR } = await import("../../test-utils/ask-turn-fixture.js");
const { runAskTurn } = await import("./ask-service.js");
const { looksLikeFollowUp } = await import("./resolver.js");
const { LlmError } = await import("../ai/llm/types.js");
const { runStream } = await import("../../test-utils/ask-turn-cases.js");

afterAll(() => {
	mock.module(REGISTRY_PATH, () => realRegistry);
	teardownAskFixture();
});

describeSqliteOnly("Ask routing (AGEN-79)", () => {
	beforeAll(async () => {
		await setupAskFixture();
	});
	beforeEach(async () => {
		await resetAskWorld();
	});

	test("'what sessions are going' answers from the Working state, not a text search for 'going'", async () => {
		const sqlite = getSqlite();
		sqlite.exec("UPDATE sessions SET is_working = 1 WHERE session_id = 'sess-alpha'");
		sqlite.exec(
			"UPDATE sessions SET display_name = 'Keep going', status = 'completed', ended_at = '2026-01-02 03:04:05' WHERE session_id = 'sess-beta'",
		);
		const out = await runSync(
			inputFor({ name: "going", message: "What sessions are going?", script: [] }),
		);
		expect(out.reply).toContain("Alpha caching work");
		expect(out.reply).toContain("(working, claude_code)");
		expect(out.reply).not.toContain("Keep going");
		// A gate answered it: the model was never asked to answer.
		expect(llm.callsOfKind("answer")).toHaveLength(0);
	});

	test("a classifier failure tells the user plainly and never repeats the classifier's error", async () => {
		llm.scriptClassifier("add-project-intent classifier", "this is not json {");
		const out = await runSync(
			inputFor({ name: "failed classifier", message: "add project gizmo please", script: [] }),
		);
		expect(out.reply).toContain("couldn't check whether this was a project-creation request");
		expect(out.reply).not.toMatch(/classifier failed|JSON|parse/i);
	});
});

describeSqliteOnly("Ask follow-ups keep the conversation's sessions (AGEN-79)", () => {
	beforeEach(async () => {
		await resetAskWorld();
		// The fixture's fake embedder scores the same session nearest to every
		// query; with no vectors stored, only the words and the carry decide.
		getSqlite().exec("DELETE FROM event_embeddings");
		// Six newer active sessions: without the carry, the recency fallback fills
		// all five slots with these and the session under discussion falls off.
		const insert = getSqlite().prepare(
			`INSERT INTO sessions (id, session_id, agent_type, status, display_name, cwd, last_activity_at, started_at)
			 VALUES (?, ?, 'claude_code', 'active', ?, '/work/other', '2026-02-01 00:00:0' || ?, '2026-02-01 00:00:00')`,
		);
		for (let i = 0; i < 6; i++) insert.run(`row-n${i}`, `sess-newer-${i}`, `Newer ${i}`, String(i));
	});

	async function turn(message: string, threadId?: string) {
		return runAskTurn({ message, actor: ASK_ACTOR, threadId });
	}

	test("a follow-up that points back is answered from the sessions of the previous answer", async () => {
		const first = await turn("tell me about the Alpha caching work");
		expect(first.includedSessionIds[0]).toBe("sess-alpha");

		const second = await turn("how many stages did it have in total?", first.thread.id);
		expect(second.includedSessionIds[0]).toBe("sess-alpha");
	});

	test("the same question with no conversation behind it carries nothing", async () => {
		const alone = await turn("how many stages did it have in total?");
		expect(alone.includedSessionIds).not.toContain("sess-alpha");
	});

	test("being short is not enough: a new question with no back-reference starts fresh", async () => {
		const first = await turn("tell me about the Alpha caching work");
		const second = await turn("how many stages total?", first.thread.id);
		expect(second.includedSessionIds).not.toContain("sess-alpha");
	});

	test("a new subject that the message names outranks the carried session, which is dropped", async () => {
		const first = await turn("tell me about the Alpha caching work");
		expect(first.includedSessionIds).toContain("sess-alpha");

		const second = await turn(
			"does it relate to the invoices handled in the Beta project?",
			first.thread.id,
		);
		expect(second.includedSessionIds[0]).toBe("sess-beta");
		expect(second.includedSessionIds).not.toContain("sess-alpha");
	});

	test("after the topic moved, the next back-reference follows the new answer, not the old one", async () => {
		const first = await turn("tell me about the Alpha caching work");
		const second = await turn(
			"does it relate to the invoices handled in the Beta project?",
			first.thread.id,
		);
		expect(second.includedSessionIds[0]).toBe("sess-beta");
		const third = await turn("what did it change?", first.thread.id);
		expect(third.includedSessionIds[0]).toBe("sess-beta");
		expect(third.includedSessionIds).not.toContain("sess-alpha");
	});

	test("at most two sessions are inherited", async () => {
		const first = await turn("tell me about the Alpha caching work and the Beta billing work");
		expect(first.includedSessionIds).toEqual(expect.arrayContaining(["sess-alpha", "sess-beta"]));
		getSqlite().exec(
			"INSERT INTO sessions (id, session_id, agent_type, status, display_name, cwd, last_activity_at, started_at) VALUES ('row-g', 'sess-gamma', 'claude_code', 'completed', 'Gamma', '/w/g', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
		);
		getSqlite().exec(
			'UPDATE ask_messages SET context_session_ids = \'["sess-alpha","sess-beta","sess-gamma"]\' WHERE role = \'assistant\'',
		);
		const second = await turn("what did they change?", first.thread.id);
		expect(second.includedSessionIds).not.toContain("sess-gamma");
	});

	test("replies from a gate record no sessions, so the carry reaches back to the last real answer", async () => {
		const first = await turn("tell me about the Alpha caching work");
		await turn("what happened today", first.thread.id); // digest gate: records none
		const third = await turn("and how many are done?", first.thread.id);
		expect(third.includedSessionIds[0]).toBe("sess-alpha");
	});

	test("the model is shown the carried session's block", async () => {
		const first = await turn("tell me about the Alpha caching work");
		llm.llmCalls.length = 0;
		await turn("what did it change?", first.thread.id);
		const answer = llm.callsOfKind("answer")[0];
		// The event text exists only in the session block, not in the history.
		expect(answer?.transcriptPrompt).toContain("fix the caching bug");
	});
});

describe("looksLikeFollowUp", () => {
	test("pronoun-like words, ordinals and connectives point back", () => {
		for (const m of [
			"what did it change?",
			"and why did that fail?",
			"what about the other one",
			"which of them is slower",
			"tell me more about the first one",
			"what else did it touch",
			"so how many are done",
		]) {
			expect({ m, v: looksLikeFollowUp(m) }).toEqual({ m, v: true });
		}
	});

	test("short questions and new subjects do not", () => {
		for (const m of [
			"how many stages total?",
			"how is billing going",
			"summarize the auth work",
			"please give me a detailed explanation of the invoice reconciliation in the Beta project",
			"   ",
		]) {
			expect({ m, v: looksLikeFollowUp(m) }).toEqual({ m, v: false });
		}
	});
});

describeSqliteOnly("Ask failure copy and logs (AGEN-79)", () => {
	beforeEach(async () => {
		await resetAskWorld();
	});

	const ask = (message: string) =>
		({ name: "failure", message, script: [] }) as Parameters<typeof inputFor>[0];

	test("an empty answer reads as 'no answer', not as an unreachable provider (sync and streamed)", async () => {
		llm.setAnswerError(new LlmError("empty_output", "openai_compatible returned no answer text"));
		for (const run of [runSync, runStream]) {
			const out = await run(inputFor(ask("hello there caching")));
			expect(out.reply).toContain("The model returned no answer");
			expect(out.reply).not.toMatch(/couldn't reach|didn't respond/);
		}
	});

	test("positive control: a timeout still reads as a timeout, other errors as unreachable", async () => {
		llm.setAnswerError(
			new LlmError("transient_timeout", "request timed out", undefined, undefined, true),
		);
		expect((await runSync(inputFor(ask("hello there caching")))).reply).toContain(
			"didn't respond in time",
		);
		llm.setAnswerError(new Error("connection refused"));
		expect((await runSync(inputFor(ask("hello there caching")))).reply).toContain(
			"couldn't reach the LLM provider",
		);
	});

	test("a failed classifier logs its gate and sub-type, and nothing of the message or the error text", async () => {
		llm.scriptClassifierError(
			"add-project-intent classifier",
			new LlmError("empty_output", "secret-provider-text"),
		);
		const lines: Array<Record<string, unknown>> = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] !== "string") return;
			try {
				lines.push(JSON.parse(args[0]));
			} catch {
				// not structured
			}
		});
		try {
			await runSync(inputFor(ask("add project gizmo please")));
		} finally {
			spy.mockRestore();
		}
		const entry = lines.find((l) => l.kind === "ask_gate_classifier_failed");
		expect(entry).toMatchObject({ gate: "project-creation", subType: "empty_output" });
		const raw = JSON.stringify(lines);
		expect(raw).not.toContain("secret-provider-text");
		expect(raw).not.toContain("add project gizmo please");
	});

	test("a silent gate's failure is logged too", async () => {
		llm.scriptClassifierError("session-Q&A classifier", new LlmError("transient_timeout", "x"));
		const lines: Array<Record<string, unknown>> = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === "string") {
				try {
					lines.push(JSON.parse(args[0]));
				} catch {
					// not structured
				}
			}
		});
		try {
			await runSync(inputFor(ask("summarize session alpha")));
		} finally {
			spy.mockRestore();
		}
		expect(lines.find((l) => l.kind === "ask_gate_classifier_failed")).toMatchObject({
			gate: "silent",
			subType: "transient_timeout",
		});
	});
});
