/**
 * What the status block of a continued Claude session says (AGEN-117 T14, Exact copy): which session it
 * continues and where, which of the person's own Claude settings apply to it (from the mode stored on the row,
 * so it is on screen before the first prompt), the way back to the original, and, once it has been ended, how
 * to keep working. Pure functions, so each sentence is tested without rendering.
 */
import { forkModeLine, forkSentenceName } from "../../../shared/claude-fork-copy.js";
import {
	FORK_MCP_OFF_REASONS,
	forkMcpAppliedLine,
	forkMcpOffLine,
} from "../../../shared/claude-fork-mcp.js";
import {
	type AppliedForkOptions,
	FORK_OPTION_MEASURED_VERSIONS,
	type ForkOptionsRequest,
} from "../../../shared/session-resume.js";
import {
	type ForkInfo,
	type ForkSource,
	KEEP_WORKING_GONE,
	continueAgain,
	sourceLabel,
	sourceUnavailable,
} from "../../lib/fork-session.js";

export const FORK_HEADING = "Continued session";
/** The instructions tab of a continued session: Claude Code loads none of the project's or the person's files there. */
export const FORK_CLAUDE_MD_NOT_LOADED = "Not loaded in this session.";

/** Why Tools and Noisy are off on a continued session: its tool calls are short lines, not events with details. */
export const FORK_TOOLS_REASON = "This session records tool activity as short lines.";
/** The same for a viewer who may open what a line ran (the owner, an admin, or anyone in solo). */
export const FORK_TOOLS_REASON_WITH_DETAIL = `${FORK_TOOLS_REASON} Open a line to see what it ran.`;

export function forkToolsReason(canReadDetail: boolean): string {
	return canReadDetail ? FORK_TOOLS_REASON_WITH_DETAIL : FORK_TOOLS_REASON;
}
export const FORK_SOURCE_DELETED = "Continued from a session that was deleted.";

export type ForkLink =
	| { kind: "link"; sourceId: string; text: string }
	| { kind: "text"; text: string };

/**
 * The line that says which fork options a session was started with, and which it asked for but didn't get
 * (a version AgentPulse hasn't measured them on, no usable file, a supervisor that can't). Null when the session
 * has no option to report, so a session without options shows exactly what it showed before. `requested` is
 * known only where the person just chose (the dialog); a stored session has what the host applied.
 */
export function forkOptionsLine(
	requested: ForkOptionsRequest | null | undefined,
	applied: AppliedForkOptions | null | undefined,
	_machine: string | null | undefined,
): string | null {
	const names = (applied?.mcpServers ?? []).map((s) => s.name);
	if (names.length > 0) return forkMcpAppliedLine(names);
	if (requested?.mcp !== true) return null;
	// Nothing applied: the host's reported version says which of the fixed reasons it is.
	const version = applied?.claudeVersion ?? "";
	const reason =
		version === ""
			? FORK_MCP_OFF_REASONS.old_supervisor
			: !FORK_OPTION_MEASURED_VERSIONS.includes(version)
				? FORK_MCP_OFF_REASONS.unmeasured_version
				: FORK_MCP_OFF_REASONS.no_file;
	return forkMcpOffLine(reason);
}

export interface ForkStatusView {
	heading: string;
	/** "Continues {Sname} on {machine}. ...": the one line a phone shows. */
	line: string;
	/** Which settings apply; null when the row doesn't say which mode it runs under. */
	modeLine: string | null;
	/** Which fork options the session runs with; null when it has none. */
	optionsLine: string | null;
	/** Shown once the session has been ended. */
	endedLine: string | null;
	link: ForkLink;
}

export interface ForkStatusInput {
	fork: ForkInfo;
	source: ForkSource;
	machine: string | null | undefined;
	managedState: string | null | undefined;
}

export function forkStatusView(input: ForkStatusInput): ForkStatusView {
	const machine = forkSentenceName(input.machine, "its machine");
	const deleted = input.source.state === "gone";
	// An archived original is still there to open, but can't be continued again: its clauses give way.
	const unavailable = sourceUnavailable(input.source);
	const label = sourceLabel(input.source);
	const subject = deleted ? "an earlier session" : label;
	return {
		heading: FORK_HEADING,
		line: `Continues ${subject} on ${machine}. Replies and approval requests appear here.`,
		modeLine: input.fork.mode
			? forkModeLine(
					input.fork.mode,
					machine,
					input.source.state === "named" ? input.source.name : null,
					unavailable,
				)
			: null,
		optionsLine: forkOptionsLine(null, input.fork.options ?? null, input.machine),
		endedLine:
			input.managedState === "stopped"
				? `You ended this session. ${
						unavailable ? KEEP_WORKING_GONE : `To keep working, ${continueAgain(input.source)}.`
					}`
				: null,
		link: deleted
			? { kind: "text", text: FORK_SOURCE_DELETED }
			: { kind: "link", sourceId: input.fork.sourceId, text: `Continued from ${label}` },
	};
}
