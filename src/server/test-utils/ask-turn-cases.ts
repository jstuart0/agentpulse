/**
 * The Ask turns the characterisation and laziness tests both drive: one case
 * per way a turn can be handled before the free-form answer, plus the
 * free-form fall-throughs, with helpers to run a case on the sync or the
 * stream path. `scripted-llm.js` must be mocked in as the LLM adapter by the
 * test file before the service is first imported.
 */
import { expect } from "bun:test";
import type { AskTurnInput } from "../services/ask/ask-service.js";
import { ASK_ACTOR } from "./ask-turn-fixture.js";
import { scriptClassifier } from "./scripted-llm.js";

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

/** Gate cases whose handler is an ASK_GATES row (the rest are intercepts after the gates). */
export const GATE_CASE_COUNT = 10;

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
	const { runAskTurn } = await import("../services/ask/ask-service.js");
	const result = await runAskTurn(input);
	return {
		reply: result.assistantMessage.content,
		included: result.includedSessionIds,
		streamedStart: null,
	};
}

export async function runStream(input: AskTurnInput): Promise<TurnOutcome> {
	const { runAskTurnStream } = await import("../services/ask/ask-service.js");
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
	for (const [needle, reply] of c.script) scriptClassifier(needle, reply);
}
