/**
 * The rows a fork's tool calls become on the timeline (AGEN-117 T10, T18). Fixed words and a tool name from
 * the fixed six, nothing else: no command, path, URL or tool input is ever in a row, because team mode
 * shares every timeline read while the approval read behind the owner-or-admin gate is where field text
 * lives. A name outside the six (impossible under `--tools`, but a model chooses the names it calls) is
 * never printed.
 */
import { TURN_REFUSED_PREFIX, TURN_UNASKED_PREFIX } from "../../shared/claude-fork-copy.js";
import type { ClaudeForkMode } from "../../shared/session-resume.js";
import { type ForkNaming, forkToolPolicy } from "./claude-fork-tools.js";
import type { ToolCallRecord } from "./fork-tool-record.js";

export type { ToolCallRecord };

/** How the turn a call belongs to stands: `running` while it is still going (a row emitted live). */
export type TurnOutcomeKind =
	| "running"
	| "completed"
	| "failed"
	| "interrupted"
	| "stopped"
	| "fatal";

export type CallRowContext = { turnOutcome: TurnOutcomeKind };

export type CallRowKind =
	| "approved"
	| "unasked"
	| "failed"
	| "declined"
	| "refused"
	| "elsewhere"
	| "local_decline"
	| "no_result";

/** The words a row may use when no option changed the tool surface: the six, then a neutral word. */
const DEFAULT_NAMING: ForkNaming = forkToolPolicy().naming;

/** The name a row may print: one of the fork's tools, else a neutral word. */
export function printableTool(name: string, naming: ForkNaming = DEFAULT_NAMING): string {
	return naming.printableTool(name);
}

/**
 * The keys a call row adds to its `rawPayload`, beside `source`, `kind` and the runtime marker. Only the
 * tool-use id in Track 0 (it pairs a Pre and a Post and is already in the compact subset); AGEN-122 owns the
 * body and adds the structured outcome keys.
 */
export function callRowPayload(
	call: ToolCallRecord,
	_ctx: CallRowContext,
): Record<string, unknown> {
	return { tool_use_id: call.toolUseId };
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

export function callRowText(call: ToolCallRecord, naming: ForkNaming = DEFAULT_NAMING): string {
	const prefix = call.agentId === null ? "" : naming.subagentPrefix;
	return `${prefix}${naming.printableTool(call.name)}: ${ROW_WORDS[callRowKind(call)]}`;
}

/** `Read (4), Bash (2)`: names from the six only, most first, ties in the order of the six. */
function countedNames(names: readonly string[], naming: ForkNaming): string {
	const counts = new Map<string, number>();
	for (const name of names) {
		const counted = naming.countedName(name);
		if (counted !== null) counts.set(counted, (counts.get(counted) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || naming.order.indexOf(a[0]) - naming.order.indexOf(b[0]))
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
	naming: ForkNaming = DEFAULT_NAMING,
): string | null {
	const names = calls.filter((c) => callRowKind(c) === "unasked").map((c) => c.name);
	const list = countedNames(names, naming);
	return list ? `${TURN_UNASKED_PREFIX} ${list}. ${UNASKED_TAIL[mode]}` : null;
}

/** The line for calls the harness refused on its own account (a config rule, not a person), or null. */
export function refusedTurnText(
	calls: readonly ToolCallRecord[],
	naming: ForkNaming = DEFAULT_NAMING,
): string | null {
	const names = calls.filter((c) => callRowKind(c) === "refused").map((c) => c.name);
	const list = countedNames(names, naming);
	return list ? `${TURN_REFUSED_PREFIX} ${list}.` : null;
}
