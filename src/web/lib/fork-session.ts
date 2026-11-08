/**
 * Whether a session is a continued Claude Code session (AGEN-117), and which settings it runs under. The
 * server puts both on the session's top level; a push or a cached list row from before that may carry them
 * only in `metadata`, which holds the same server-owned keys. One place reads both, so no screen decides on
 * its own what counts as a fork.
 */
import {
	type ForkMode,
	ORIGINAL_SESSION_FALLBACK,
	forkSentenceName,
} from "../../shared/claude-fork-copy.js";
import { type AppliedForkOptions, parseAppliedForkOptions } from "../../shared/session-resume.js";
import type { Session } from "../../shared/types.js";

type ForkFields = Partial<
	Pick<Session, "forkedFromSessionId" | "forkPermissionBranch" | "metadata">
>;

export interface ForkInfo {
	/** The observed session it was forked from. */
	sourceId: string;
	/** The mode the host picked for it; null when the row doesn't say (an older fork). */
	mode: ForkMode | null;
	/** What the host applied of the options the person asked for (AGEN-121); absent for a session from before them. */
	options?: AppliedForkOptions;
}

function asMode(value: unknown): ForkMode | null {
	return value === "ask" || value === "restricted" ? value : null;
}

export function forkInfo(session: ForkFields): ForkInfo | null {
	const meta = session.metadata ?? null;
	const from = session.forkedFromSessionId ?? meta?.forkedFromSessionId;
	if (typeof from !== "string" || from === "") return null;
	const options = parseAppliedForkOptions(meta?.forkOptions);
	return {
		sourceId: from,
		mode: asMode(session.forkPermissionBranch ?? meta?.forkPermissionBranch),
		...(options ? { options } : {}),
	};
}

export function isFork(session: ForkFields): boolean {
	return forkInfo(session) !== null;
}

/**
 * What the page knows about the session a fork came from: its name, that it was archived (still there, with
 * a link, but it can't be continued again), that it is gone, or nothing yet.
 */
export type ForkSource =
	| { state: "named"; name: string }
	| { state: "archived"; name: string | null }
	| { state: "gone" }
	| { state: "unknown" };

/** The source as the detail read resolved it (`continuedFrom`); "unknown" when the server didn't say. */
export function forkSourceOf(session: Pick<Session, "continuedFrom">): ForkSource {
	const from = session.continuedFrom;
	if (!from) return { state: "unknown" };
	if (from.state === "deleted") return { state: "gone" };
	if (from.state === "archived") return { state: "archived", name: from.name };
	return from.name ? { state: "named", name: from.name } : { state: "unknown" };
}

/** Whether the original can't be continued again: deleted or archived. Its "continue {Sname}" clauses give way. */
export function sourceUnavailable(source: ForkSource): boolean {
	return source.state === "gone" || source.state === "archived";
}

/** Said where the original is deleted or archived, in place of any "continue {Sname}" clause. */
export const KEEP_WORKING_GONE =
	"To keep working, start a new session. What happened here stays in this session's timeline.";

/** The original's name as a sentence may print it: cleaned, no backticks, or the neutral words. */
export function sourceLabel(source: ForkSource): string {
	return forkSentenceName(
		source.state === "named" || source.state === "archived" ? source.name : null,
		ORIGINAL_SESSION_FALLBACK,
	);
}

/** "continue {Sname} in a new session again", or, with the original gone or archived, "start a new session". */
export function continueAgain(source: ForkSource): string {
	return sourceUnavailable(source)
		? "start a new session"
		: `continue ${sourceLabel(source)} in a new session again`;
}
