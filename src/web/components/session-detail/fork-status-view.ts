/**
 * What the status block of a continued Claude session says (AGEN-117 T14, Exact copy): which session it
 * continues and where, which of the person's own Claude settings apply to it (from the mode stored on the row,
 * so it is on screen before the first prompt), the way back to the original, and, once it has been ended, how
 * to keep working. Pure functions, so each sentence is tested without rendering.
 */
import { forkModeLine, forkSentenceName } from "../../../shared/claude-fork-copy.js";
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
export const FORK_SOURCE_DELETED = "Continued from a session that was deleted.";

export type ForkLink =
	| { kind: "link"; sourceId: string; text: string }
	| { kind: "text"; text: string };

export interface ForkStatusView {
	heading: string;
	/** "Continues {Sname} on {machine}. ...": the one line a phone shows. */
	line: string;
	/** Which settings apply; null when the row doesn't say which mode it runs under. */
	modeLine: string | null;
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
