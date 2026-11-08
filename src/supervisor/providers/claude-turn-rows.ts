/**
 * The rows a fork's tool calls become on the timeline (AGEN-117 T10, T18). Fixed words and a tool name from
 * the fixed six, nothing else: no command, path, URL or tool input is ever in a row, because team mode
 * shares every timeline read while the approval read behind the owner-or-admin gate is where field text
 * lives. A name outside the six (impossible under `--tools`, but a model chooses the names it calls) is
 * never printed.
 */
import {
	type ForkCallOutcome,
	TURN_REFUSED_PREFIX,
	TURN_UNASKED_PREFIX,
	reportedForkTool,
} from "../../shared/claude-fork-copy.js";
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

/** `Exit code <digits>` at the very start of a Bash result, then a line break or the end of the text. */
const EXIT_CODE_LINE = /^Exit code (\d+)(?:\n|$)/;
const MAX_EXIT_CODE = 255;

/**
 * The exit code Claude printed for a failed Bash call, or null. Nothing is inferred: a success prints no
 * prefix, so a success has no code and never a 0 (a made-up 0 would let the Summary call something passed).
 * Only an integer in [0, 255] counts; anything else Claude might print is left out.
 */
export function bashExitCodeOf(call: ToolCallRecord): number | null {
	if (call.name !== "Bash" || call.detailResult === null) return null;
	const match = EXIT_CODE_LINE.exec(call.detailResult);
	if (!match) return null;
	const code = Number(match[1]);
	return Number.isSafeInteger(code) && code <= MAX_EXIT_CODE ? code : null;
}

/** `tool_result_meta[].non_execution_kind` Claude 2.1.319 gives a call cut short by an interrupt (recorded: `int-bash-key`). */
const INTERRUPTED_NON_EXECUTION_KIND = "user-rejected";

/**
 * A call whose error is the interrupt's: it resulted with an error that no permission decision made. A refusal
 * by a rule or a person's card carries a `permission_decision` (`config`, `user_reject`); an interrupted call
 * carries none, and its `non_execution_kind` is `user-rejected` (or absent on a tool that ran to its end).
 */
function erroredByInterrupt(call: ToolCallRecord): boolean {
	return (
		call.resulted &&
		call.isError &&
		!call.declinedLocally &&
		!call.decidedElsewhere &&
		call.decisionSource === null &&
		(call.nonExecutionKind === null || call.nonExecutionKind === INTERRUPTED_NON_EXECUTION_KIND)
	);
}

/**
 * What a call's row says happened. An errored call of a turn a person stopped is `stopped`, not `failed`: the
 * error is the interrupt's, and it must not read as a tool failure (F39).
 */
export function callRowOutcome(call: ToolCallRecord, ctx?: CallRowContext): ForkCallOutcome {
	if (ctx?.turnOutcome === "interrupted" && erroredByInterrupt(call)) return "stopped";
	return callRowKind(call);
}

/**
 * The keys a call row adds to its `rawPayload`, beside `source`, `kind` and the runtime marker: the
 * structured outcome, never the command, path, URL or output. `tool` is one of the fixed six, or `mcp` for any
 * MCP tool (never the server or tool name); `exit_code` only when Claude printed one for a failed Bash call.
 */
export function callRowPayload(call: ToolCallRecord, ctx: CallRowContext): Record<string, unknown> {
	const toolOutcome = callRowOutcome(call, ctx);
	const tool = reportedForkTool(call.name);
	const exitCode = toolOutcome === "failed" ? bashExitCodeOf(call) : null;
	return {
		...(tool === null ? {} : { tool }),
		toolOutcome,
		is_error: call.isError,
		...(exitCode === null ? {} : { exit_code: exitCode }),
		tool_use_id: call.toolUseId,
	};
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

const ROW_WORDS: Record<ForkCallOutcome, string> = {
	approved: "ran, you approved it",
	unasked: "ran without asking",
	failed: "didn't succeed",
	declined: "you declined it",
	refused: "refused",
	elsewhere: "may have run",
	local_decline: "AgentPulse declined it; you weren't asked",
	no_result: "called, no result seen",
	stopped: "stopped when you stopped the turn",
};

export function callRowText(
	call: ToolCallRecord,
	naming: ForkNaming = DEFAULT_NAMING,
	ctx?: CallRowContext,
): string {
	const prefix = call.agentId === null ? "" : naming.subagentPrefix;
	return `${prefix}${naming.printableTool(call.name)}: ${ROW_WORDS[callRowOutcome(call, ctx)]}`;
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
