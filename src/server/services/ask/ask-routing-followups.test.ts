/**
 * AGEN-79: how an Ask turn is routed and what a follow-up carries over.
 * Whole turns through the scripted LLM and the shared Ask fixture, so the
 * routing decision is asserted on what the user reads, not on a helper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

	test("a short follow-up is answered from the sessions of the previous answer", async () => {
		const first = await turn("tell me about the Alpha caching work");
		expect(first.includedSessionIds[0]).toBe("sess-alpha");

		const second = await turn("how many stages are there in total?", first.thread.id);
		expect(second.includedSessionIds).toContain("sess-alpha");
		expect(second.includedSessionIds[0]).toBe("sess-alpha");
	});

	test("the same short question with no conversation behind it carries nothing", async () => {
		const alone = await turn("how many stages are there in total?");
		expect(alone.includedSessionIds).not.toContain("sess-alpha");
	});

	test("a message that names its own subject is resolved on its own words, not the previous session", async () => {
		const first = await turn("tell me about the Alpha caching work");
		expect(first.includedSessionIds).toContain("sess-alpha");

		const second = await turn(
			"please give me a detailed explanation of the invoice reconciliation that happened in the Beta project",
			first.thread.id,
		);
		expect(second.includedSessionIds).toContain("sess-beta");
		expect(second.includedSessionIds).not.toContain("sess-alpha");
	});

	test("replies from a gate record no sessions, so the carry reaches back to the last real answer", async () => {
		const first = await turn("tell me about the Alpha caching work");
		await turn("what's waiting", first.thread.id); // search gate: records none
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
	test("short messages and back-references are follow-ups", () => {
		for (const m of [
			"how many stages total?",
			"what about the other one",
			"and why did it fail?",
			"Can you explain it in more detail, including what happened to the tests in the run",
		]) {
			expect({ m, v: looksLikeFollowUp(m) }).toEqual({ m, v: true });
		}
	});

	test("a long message with its own subject is not", () => {
		expect(
			looksLikeFollowUp(
				"please give me a detailed explanation of the invoice reconciliation in the Beta project",
			),
		).toBe(false);
		expect(looksLikeFollowUp("   ")).toBe(false);
	});
});
