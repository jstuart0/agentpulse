/**
 * Characterisation of what an Ask turn answers today, for every way a turn
 * can end: each intent gate, the launch intercepts, and the free-form LLM
 * fall-through. It pins the assistant's reply, the sessions it says it used
 * and, for the fall-through, the exact prompts the LLM was sent, on both the
 * synchronous and the streaming path.
 *
 * It exists so that moving semantic enrichment out of `prepareTurn` (it must
 * run only where its output is consumed) can be shown to change no answer.
 * It says nothing about how much work a turn does: that is
 * `ask-context-lazy.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { describeSqliteOnly } from "../../test-utils/backend.js";
import "../ai/__test_db.js";

const llm = await import("../../test-utils/scripted-llm.js");
// mock.module replaces the module for the whole process and is not undone when the file ends;
// keep the real registry and put it back in afterAll (AGEN-69 P2-26).
const REGISTRY_PATH = "../ai/llm/registry.js";
const realRegistry = { ...(await import("../ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { resetAskWorld, setupAskFixture, teardownAskFixture } = await import(
	"../../test-utils/ask-turn-fixture.js"
);
const {
	FALLTHROUGH_CASES,
	HANDLED_CASES,
	applyScript,
	inputFor,
	normaliseNonce,
	normaliseReply,
	runStream,
	runSync,
} = await import("../../test-utils/ask-turn-cases.js");

/** Pinned: what each case answered on the code before enrichment moved (reply text, ids, times normalised). */
const EXPECTED: Record<string, { reply: string; included: string[]; transcript?: string }> = {
	"session Q&A": {
		reply:
			"QA ANSWER\n\nBased on the most recent 1 events from 2026-01-02 03:04 to 2026-01-02 03:04.",
		included: [],
	},
	"add project": {
		reply: "What is the working directory? (absolute path, e.g. /home/me/myapp)",
		included: [],
	},
	digest: {
		reply: "**Session digest (last 24h):**\n\n\n**Totals:** 0 sessions",
		included: [],
	},
	"natural-language search": {
		reply: "• **Alpha caching work** (active, claude_code) — fix the caching bug",
		included: [],
	},
	"bulk session action": {
		reply: "No sessions matched that description.",
		included: [],
	},
	"single-session action": {
		reply: "Pinned **Alpha caching work**.",
		included: [],
	},
	"resume (agent refused)": {
		reply:
			"Resume isn't supported for Copilot CLI sessions — AgentPulse can only launch Claude Code or Codex.",
		included: [],
	},
	"project/template CRUD": {
		reply: "I couldn't find a project named **nope**. Check Projects for the exact name.",
		included: [],
	},
	"channel setup": {
		reply:
			"I've queued a new **telegram** channel setup — approve in inbox to create it. After approval, you'll receive setup instructions.",
		included: [],
	},
	"alert rule": {
		reply:
			"I need to know which project to watch. Known projects: **gizmo**. Which one did you mean?",
		included: [],
	},
	"launch (agent refused)": {
		reply: "Copilot CLI can't be launched — AgentPulse can only launch Claude Code or Codex.",
		included: [],
	},
	"launch needs a project (disambiguation)": {
		reply:
			'Which project should I work in? Reply with a number or paste an absolute path.\n\n1. gizmo  (/tmp/gizmo)\n\n```ask-message-meta\n{"kind":"project_picker","draftId":"<uuid>","choices":[{"id":"proj-gizmo","name":"gizmo","cwd":"/tmp/gizmo"}],"telegramOrigin":false,"canScaffold":false}\n```',
		included: [],
	},
	"fall-through: greeting that matches no gate": {
		reply: "ANSWER",
		included: ["sess-alpha"],
		transcript:
			'<history>\nUSER: hello there caching\n</history>\n\n<sessions-<nonce>>\n## Session: Alpha caching work\n- id: sess-alpha\n- agent: claude_code\n- status: active · tool uses: 0\n- cwd: "/work/alpha"\n- last activity: 2026-01-02 03:04:05\n- recent events (oldest → newest):\n   - [2026-01-02 03:04:05] UserPromptSubmit: fix the caching bug\n</sessions-<nonce>>\n\nUSER: hello there caching',
	},
	"fall-through: gate passes but the classifier declines": {
		reply: "ANSWER",
		included: ["sess-alpha"],
		transcript:
			'<history>\nUSER: stop worrying about the caching\n</history>\n\n<sessions-<nonce>>\n## Session: Alpha caching work\n- id: sess-alpha\n- agent: claude_code\n- status: active · tool uses: 0\n- cwd: "/work/alpha"\n- last activity: 2026-01-02 03:04:05\n- recent events (oldest → newest):\n   - [2026-01-02 03:04:05] UserPromptSubmit: fix the caching bug\n</sessions-<nonce>>\n\nUSER: stop worrying about the caching',
	},
	"fall-through: explicit session ids": {
		reply: "ANSWER",
		included: ["sess-beta"],
		transcript:
			'<history>\nUSER: hello there\n</history>\n\n<sessions-<nonce>>\n## Session: Beta billing work\n- id: sess-beta\n- agent: claude_code\n- status: active · tool uses: 0\n- cwd: "/work/beta"\n- last activity: 2026-01-02 03:04:05\n- recent events (oldest → newest):\n   - [2026-01-02 03:04:05] UserPromptSubmit: reconcile the invoices\n</sessions-<nonce>>\n\nUSER: hello there',
	},
};

describeSqliteOnly("what an Ask turn answers today", () => {
	beforeAll(setupAskFixture);
	afterAll(() => {
		mock.module(REGISTRY_PATH, () => realRegistry);
		teardownAskFixture();
	});
	beforeEach(resetAskWorld);

	for (const c of HANDLED_CASES) {
		describe(c.name, () => {
			for (const [path, run] of [
				["sync", runSync],
				["stream", runStream],
			] as const) {
				test(`${path}: the reply and the sessions it reports`, async () => {
					applyScript(c);
					const outcome = await run(inputFor(c));
					const observed = { reply: normaliseReply(outcome.reply), included: outcome.included };
					expect(observed).toEqual(EXPECTED[c.name] as never);
				});
			}
		});
	}

	for (const c of FALLTHROUGH_CASES) {
		describe(`fall-through: ${c.name}`, () => {
			for (const [path, run] of [
				["sync", runSync],
				["stream", runStream],
			] as const) {
				test(`${path}: the prompts the LLM is sent, the reply and the sessions`, async () => {
					applyScript(c);
					llm.setAnswerText("ANSWER");
					const outcome = await run(inputFor(c));
					const answer = llm.callsOfKind("answer");
					expect(answer.length).toBe(1);
					const observed = {
						reply: outcome.reply,
						included: outcome.included,
						transcript: normaliseNonce(answer[0]?.transcriptPrompt ?? ""),
					};
					expect(observed).toEqual(EXPECTED[`fall-through: ${c.name}`] as never);
				});
			}
		});
	}
});
