/**
 * The rows a fork's tool calls become on the timeline (AGEN-117 T10, T18). Fixed words and a tool name from
 * the fixed six, nothing else: no command, path, URL or tool input is ever in a row, because team mode
 * shares every timeline read while the approval read behind the owner-or-admin gate is where field text
 * lives. A name outside the six (impossible under `--tools`, but a model chooses the names it calls) is
 * never printed.
 */
import type { ClaudeForkMode } from "../../shared/session-resume.js";
import { CLAUDE_FORK_TOOLS } from "./claude-argv.js";

/** What the stream showed about one tool call in a turn. */
export type ToolCallRecord = {
	toolUseId: string;
	/** The name as the model wrote it; only printed when it is one of the six. */
	name: string;
	/** A `can_use_tool` request arrived for this call. */
	requested: boolean;
	/** What was written back to Claude for the request, or null (none yet, or none at all). */
	answer: "allow" | "deny" | null;
	/** The tracker saw something else decide first; the call may have run. */
	decidedElsewhere: boolean;
	/** The host declined it itself because it could not be shown to a person: nobody was asked. */
	declinedLocally: boolean;
	/** The tool_result arrived. */
	resulted: boolean;
	isError: boolean;
	/** `tool_result_meta[].non_execution_kind`, when the harness refused to run the call. */
	nonExecutionKind: string | null;
	/** `tool_result_meta[].permission_decision.source`. */
	decisionSource: string | null;
};

export type CallRowKind =
	| "approved"
	| "unasked"
	| "failed"
	| "declined"
	| "refused"
	| "elsewhere"
	| "local_decline"
	| "no_result";

const SIX: readonly string[] = CLAUDE_FORK_TOOLS;

/** The name a row may print: one of the six, else a neutral word. */
export function printableTool(name: string): string {
	return SIX.includes(name) ? name : "A tool";
}

/** Which row a call earns, in the order T18's table reads. */
export function callRowKind(call: ToolCallRecord): CallRowKind {
	// Judged first: whatever Claude then reported about the result, the person was never asked, and a row must
	// not say they declined something they never saw.
	if (call.declinedLocally) return "local_decline";
	if (call.decidedElsewhere) return "elsewhere";
	if (!call.resulted) return "no_result";
	if (call.nonExecutionKind !== null) {
		return call.decisionSource === "user_reject" ? "declined" : "refused";
	}
	if (call.isError) return "failed";
	return call.requested && call.answer === "allow" ? "approved" : "unasked";
}

const ROW_WORDS: Record<CallRowKind, string> = {
	approved: "ran, you approved it",
	unasked: "ran without asking",
	failed: "didn't succeed",
	declined: "you declined it",
	refused: "refused",
	elsewhere: "may have run",
	local_decline: "AgentPulse declined it; you weren't asked",
	no_result: "called, no result seen",
};

export function callRowText(call: ToolCallRecord): string {
	return `${printableTool(call.name)}: ${ROW_WORDS[callRowKind(call)]}`;
}

/** `Read (4), Bash (2)`: names from the six only, most first, ties in the order of the six. */
function countedNames(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) {
		if (SIX.includes(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || SIX.indexOf(a[0]) - SIX.indexOf(b[0]))
		.map(([name, n]) => `${name} (${n})`)
		.join(", ");
}

const UNASKED_TAIL: Record<ClaudeForkMode, string> = {
	ask: "These were read-only, or your Claude settings allowed them.",
	restricted: "Claude treated these as read-only.",
};

/**
 * The line for what ran with no request this turn, or null when nothing did (or only a name outside the six
 * did: it is not listed, so there is nothing to say). An approved or declined call is never counted here.
 */
export function unaskedTurnText(
	calls: readonly ToolCallRecord[],
	mode: ClaudeForkMode,
): string | null {
	const names = calls.filter((c) => callRowKind(c) === "unasked").map((c) => c.name);
	const list = countedNames(names);
	return list ? `Ran without asking you this turn: ${list}. ${UNASKED_TAIL[mode]}` : null;
}

/** The line for calls the harness refused on its own account (a config rule, not a person), or null. */
export function refusedTurnText(calls: readonly ToolCallRecord[]): string | null {
	const names = calls.filter((c) => callRowKind(c) === "refused").map((c) => c.name);
	const list = countedNames(names);
	return list ? `Claude tried this and was refused: ${list}.` : null;
}
