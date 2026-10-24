/**
 * The deterministic gate in front of an unattended send. Before the watcher may
 * type anything into a session on its own, three plain facts about the turn that
 * just ended are checked, none of them a judgement by the model:
 *
 *  - the agent's last message asked something, or is waiting on someone;
 *  - the turn holds a permission request or a notification (a prompt is open);
 *  - a risk class matches the agent's last message or the action it was about to take.
 *
 * Any of them sends the turn to a person. Pure: it reads the events it is given.
 */
import type { SessionEvent } from "../../../shared/types.js";
import { type RiskClassesConfig, evaluateRisk } from "./risk-classes.js";

/**
 * Phrases of someone waiting for an answer. Fixed words, word-bounded, no
 * nested quantifiers: linear in the message it is run over.
 */
export const ASKS_HUMAN_RE =
	/\b(?:should i|shall i|do you want|would you like|can you confirm|please confirm|let me know|waiting for|approve|permission)\b/i;

/** How much of the end of the last message is read for those phrases. */
const LAST_MESSAGE_TAIL_CHARS = 600;

export type HumanGateResult = { hold: false } | { hold: true; why: string };

export const ASKING_WHY = "The agent is asking you something.";
export const PERMISSION_WHY = "A permission prompt is open.";

/**
 * The events of the turn that ended at `trigger`: everything after the newest
 * prompt at or before it, up to and including it.
 */
export function eventsOfTurn(recent: readonly SessionEvent[], triggerId: number): SessionEvent[] {
	const upTo = recent.filter((e) => e.id <= triggerId);
	let start = -1;
	for (let i = upTo.length - 1; i >= 0; i -= 1) {
		if (upTo[i]?.category === "prompt") {
			start = i;
			break;
		}
	}
	return upTo.slice(start + 1);
}

function lastAssistantMessage(turn: readonly SessionEvent[]): string {
	for (let i = turn.length - 1; i >= 0; i -= 1) {
		const e = turn[i];
		if (e?.category === "assistant_message") return e.content ?? "";
	}
	return "";
}

function asksSomething(message: string): boolean {
	const trimmed = message.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
	if (trimmed === "") return false;
	if (trimmed.endsWith("?")) return true;
	return ASKS_HUMAN_RE.test(trimmed.slice(-LAST_MESSAGE_TAIL_CHARS));
}

function toolUseIdOf(e: SessionEvent): string | null {
	const id = e.rawPayload?.tool_use_id;
	return typeof id === "string" && id !== "" ? id : null;
}

/** The newest `PreToolUse` of the turn that no later `PostToolUse` answers, as text a risk class can match. */
export function pendingAction(turn: readonly SessionEvent[]): string | null {
	for (let i = turn.length - 1; i >= 0; i -= 1) {
		const pre = turn[i];
		if (pre?.eventType !== "PreToolUse") continue;
		const id = toolUseIdOf(pre);
		const answered = turn.slice(i + 1).some((later) => {
			if (later.eventType !== "PostToolUse" && later.eventType !== "PostToolUseFailure") {
				return false;
			}
			return id !== null ? toolUseIdOf(later) === id : later.toolName === pre.toolName;
		});
		if (answered) continue;
		return `${pre.toolName ?? ""} ${pre.toolInput ? JSON.stringify(pre.toolInput) : ""}`.trim();
	}
	return null;
}

export function needsHuman(
	turn: readonly SessionEvent[],
	riskConfig: RiskClassesConfig,
): HumanGateResult {
	const last = lastAssistantMessage(turn);
	if (asksSomething(last)) return { hold: true, why: ASKING_WHY };

	if (
		turn.some(
			(e) =>
				e.category === "permission_event" ||
				e.eventType === "PermissionRequest" ||
				e.eventType === "Notification",
		)
	) {
		return { hold: true, why: PERMISSION_WHY };
	}

	const pending = pendingAction(turn);
	const texts = [last, pending].filter((t): t is string => t !== null && t !== "");
	const labels = new Set<string>();
	for (const proposedPrompt of texts) {
		for (const hit of evaluateRisk(riskConfig, { proposedPrompt })) labels.add(hit.label);
	}
	if (labels.size > 0) {
		return { hold: true, why: `Risk class(es) matched: ${[...labels].join(", ")}` };
	}
	return { hold: false };
}
