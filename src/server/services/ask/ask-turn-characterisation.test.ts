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
mock.module("../ai/llm/registry.js", () => ({ getAdapter: () => llm.scriptedAdapter }));

const { ASK_ACTOR, resetAskWorld, setupAskFixture, teardownAskFixture } = await import(
	"../../test-utils/ask-turn-fixture.js"
);
const { runAskTurn, runAskTurnStream } = await import("./ask-service.js");

import type { AskTurnInput } from "./ask-service.js";

export interface GateCase {
	name: string;
	message: string;
	/** Classifier replies, keyed by a substring of the classifier's system prompt. */
	script: Array<[string, unknown]>;
	input?: Partial<AskTurnInput>;
}

const REFUSE_COPILOT = { intent: "resume", sessionHint: "alpha", agentType: "copilot_cli" };

/** One row per way a turn can be handled before the free-form answer. */
export const HANDLED_CASES: GateCase[] = [
	{
		name: "session Q&A",
		message: "summarize session alpha",
		script: [
			["session-Q&A classifier", { intent: "qa", sessionHint: "alpha" }],
			["analyzing an AI coding session", "QA ANSWER"],
		],
	},
	{
		name: "add project",
		message: "add project gizmo",
		script: [
			["add-project-intent classifier", { intent: "add_project", name: "gizmo", cwd: null }],
		],
	},
	{ name: "digest", message: "what happened today", script: [] },
	{ name: "natural-language search", message: "find session about caching", script: [] },
	{
		name: "bulk session action",
		message: "archive all completed sessions",
		script: [
			[
				"bulk-session-action classifier",
				{
					intent: "bulk_action",
					action: "archive",
					filter: { strategy: "attribute", status: "completed" },
				},
			],
		],
	},
	{
		name: "single-session action",
		message: "pin the alpha session",
		script: [
			[
				"session-action classifier",
				{ intent: "session_action", action: "pin", sessionHint: "alpha" },
			],
		],
	},
	{
		name: "resume (agent refused)",
		message: "continue alpha with: do the next step",
		script: [["session-resume classifier", REFUSE_COPILOT]],
	},
	{
		name: "project/template CRUD",
		message: "delete project nope",
		script: [["CRUD classifier", { intent: "delete_project", targetName: "nope" }]],
	},
	{ name: "channel setup", message: "add telegram channel", script: [] },
	{
		name: "alert rule",
		message: "alert me when a session fails",
		script: [["alert-rule classifier", { intent: "create_alert_rule", ruleType: "status_failed" }]],
	},
	{
		name: "launch (agent refused)",
		message: "start a claude session on the gizmo project",
		script: [
			[
				"launch-intent classifier",
				{ intent: "launch", projectName: "gizmo", agentType: "copilot_cli" },
			],
		],
	},
	{
		name: "launch needs a project (disambiguation)",
		message: "start a claude session to fix a bug",
		script: [["launch-intent classifier", { intent: "launch_needs_project" }]],
	},
];

/** Free-form fall-throughs: the answer is the LLM's, and the context block is built. */
export const FALLTHROUGH_CASES: GateCase[] = [
	{ name: "greeting that matches no gate", message: "hello there caching", script: [] },
	{
		name: "gate passes but the classifier declines",
		message: "stop worrying about the caching",
		script: [],
	},
	{
		name: "explicit session ids",
		message: "hello there",
		script: [],
		input: { sessionIds: ["sess-beta"] },
	},
];

const NONCE = /sessions-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replaces the per-turn nonce in the context tags; fails if there was none to replace. */
export function normaliseNonce(text: string): string {
	expect(text).toMatch(NONCE);
	return text.replace(NONCE, "sessions-<nonce>");
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

/** Ids and times that differ run to run; a reply with neither passes through unchanged. */
export function normaliseReply(text: string): string {
	return text.replace(UUID, "<uuid>").replace(STAMP, "<time>");
}

export interface TurnOutcome {
	reply: string;
	included: string[];
	streamedStart: string[] | null;
}

export async function runSync(input: AskTurnInput): Promise<TurnOutcome> {
	const result = await runAskTurn(input);
	return {
		reply: result.assistantMessage.content,
		included: result.includedSessionIds,
		streamedStart: null,
	};
}

export async function runStream(input: AskTurnInput): Promise<TurnOutcome> {
	let start: string[] | null = null;
	let deltas = "";
	let final = "";
	for await (const event of runAskTurnStream(input)) {
		if (event.kind === "start") start = event.includedSessionIds;
		if (event.kind === "delta") deltas += event.delta;
		if (event.kind === "done" || event.kind === "error")
			final = event.assistantMessage?.content ?? "";
	}
	return { reply: final || deltas, included: start ?? [], streamedStart: start };
}

export function inputFor(c: GateCase): AskTurnInput {
	return { message: c.message, actor: ASK_ACTOR, ...c.input };
}

export function applyScript(c: GateCase): void {
	for (const [needle, reply] of c.script) llm.scriptClassifier(needle, reply);
}

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
	afterAll(teardownAskFixture);
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
