/**
 * AGEN-79: how an Ask turn is routed and what a follow-up carries over.
 * Whole turns through the scripted LLM and the shared Ask fixture, so the
 * routing decision is asserted on what the user reads, not on a helper.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
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
