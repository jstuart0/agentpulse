/**
 * What a continued Claude session's host may put in a row's `rawPayload` and `content` (AGEN-122, F14, F51).
 * Every managed event of a fork session (`metadata.forkedFromSessionId`, whatever marker the sender sets) is
 * rebuilt from a whitelist of its kind, and a call row's text must be the fixed words, so a supervisor bug (or
 * a host that is not what it says it is) can never store a command, path, URL or tool output in a row that
 * team mode shares: the timeline read is not owner-checked, the approval read is.
 *
 * Pure: the same input always gives the same output. A payload of a session that is not a fork and does not
 * carry the marker is returned as it came.
 */
import {
	FORK_CALL_OUTCOMES,
	FORK_CALL_ROW_WORDS,
	FORK_REPORTED_TOOLS,
	FORK_UNASKED_TAIL,
	type ForkCallOutcome,
	TURN_REFUSED_PREFIX,
	TURN_UNASKED_PREFIX,
} from "../../shared/claude-fork-copy.js";

const MARKER_KEY = "claudeStreamRuntime";
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A short machine word (`claude_stream`, `completed`, `turn_error`), never free text. */
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_EXIT_CODE = 255;

const token = (value: unknown): string | undefined =>
	typeof value === "string" && TOKEN.test(value) ? value : undefined;

/** Only defined values are copied, so a key that failed its check is absent rather than `undefined`. */
function compact(entries: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

function callRow(raw: Record<string, unknown>): Record<string, unknown> {
	const tool = raw.tool;
	const outcome = raw.toolOutcome;
	const exitCode = raw.exit_code;
	const toolUseId = raw.tool_use_id;
	return {
		tool:
			typeof tool === "string" && (FORK_REPORTED_TOOLS as readonly string[]).includes(tool)
				? tool
				: undefined,
		toolOutcome:
			typeof outcome === "string" && (FORK_CALL_OUTCOMES as readonly string[]).includes(outcome)
				? (outcome as ForkCallOutcome)
				: undefined,
		is_error: typeof raw.is_error === "boolean" ? raw.is_error : undefined,
		exit_code:
			typeof exitCode === "number" &&
			Number.isInteger(exitCode) &&
			exitCode >= 0 &&
			exitCode <= MAX_EXIT_CODE
				? exitCode
				: undefined,
		tool_use_id:
			typeof toolUseId === "string" && TOOL_USE_ID.test(toolUseId) ? toolUseId : undefined,
	};
}

/**
 * True for a managed `HeadlessStatus` row the host marked as a continued Claude session's own row with a `kind`
 * (`call`, `turn_unasked`, `turn_refused`, ...). Each stands for a distinct occurrence even when its text repeats
 * (the same tool call in a second turn), and the timeline row is what carries the Details control, so the
 * content window must not drop it. The marker is sender-supplied: a forged one only lets that supervisor's own
 * session keep duplicate rows, since supervisor writes are ownership-checked.
 */
export function isForkRowEvent(event: {
	eventType: string;
	rawPayload?: Record<string, unknown> | null;
}): boolean {
	const raw = event.rawPayload;
	return (
		event.eventType === "HeadlessStatus" &&
		raw?.[MARKER_KEY] === true &&
		typeof raw.kind === "string" &&
		raw.kind !== ""
	);
}

/**
 * Rows by `kind`. `turn_unasked` and `turn_refused` carry their counted names in their content only, so they
 * keep no payload beyond the three every kind keeps. A row with no `kind` is a turn or lifecycle event
 * (`HeadlessPromptFailed` and the like): it keeps its `status`, and `code` where a refusal names one.
 */
export function normalizeForkRowPayload(
	raw: Record<string, unknown>,
	isForkSession = false,
): Record<string, unknown> {
	const marked = raw[MARKER_KEY] === true;
	if (!marked && !isForkSession) return raw;
	const kind = token(raw.kind);
	// The marker is kept only when the sender set it: it decides which agent's turn an event may move.
	const common = { source: token(raw.source), kind, ...(marked ? { [MARKER_KEY]: true } : {}) };
	if (kind === "call") return compact({ ...common, ...callRow(raw) });
	if (raw.kind === undefined) {
		return compact({ ...common, status: token(raw.status), code: token(raw.code) });
	}
	return compact(common);
}

const TOOL_WORD = /^(?:Subagent |A subagent's )?(?:[A-Za-z][A-Za-z0-9_.-]{0,127}|A tool)$/;
const COUNTED_NAMES = /^[A-Za-z0-9_.\-]+ \(\d{1,3}\)(?:, [A-Za-z0-9_.\-]+ \(\d{1,3}\))*$/;
const UNASKED_TAILS = Object.values(FORK_UNASKED_TAIL);
const ROW_SENTENCES = Object.values(FORK_CALL_ROW_WORDS);

/**
 * The text of a fork's `HeadlessStatus` row. A call row is `<tool>: <the fixed words for its outcome>`; the two
 * per-turn rows are their fixed prefix, counted tool names and a fixed tail. Anything else (a sender that put
 * output in `content`, a kind that has no text) is replaced by words built from the whitelisted payload alone,
 * so no host text survives. Other event types keep their content: a prompt is the person's, an assistant
 * message is the agent's own words, and the rest are fixed by the host.
 */
export function constrainForkRowContent(
	event: { eventType: string },
	payload: Record<string, unknown>,
	content: string | null,
): string | null {
	if (event.eventType !== "HeadlessStatus") return content;
	const kind = payload.kind;
	if (kind === "call") {
		// Kept when it is `<tool>: <one of the fixed sentences>` (the real host's rows always are).
		if (content !== null) {
			for (const words of ROW_SENTENCES) {
				const suffix = `: ${words}`;
				if (content.endsWith(suffix) && TOOL_WORD.test(content.slice(0, -suffix.length))) {
					return content;
				}
			}
		}
		// Otherwise rebuilt from the whitelisted payload alone, or no text when it names no outcome.
		const outcome = payload.toolOutcome as ForkCallOutcome | undefined;
		const words = outcome === undefined ? undefined : FORK_CALL_ROW_WORDS[outcome];
		if (words === undefined) return null;
		return `${typeof payload.tool === "string" ? payload.tool : "A tool"}: ${words}`;
	}
	if (kind === "turn_unasked" || kind === "turn_refused") {
		const prefix = kind === "turn_unasked" ? TURN_UNASKED_PREFIX : TURN_REFUSED_PREFIX;
		if (content?.startsWith(`${prefix} `)) {
			const rest = content.slice(prefix.length + 1);
			if (kind === "turn_refused" && rest.endsWith(".") && COUNTED_NAMES.test(rest.slice(0, -1))) {
				return content;
			}
			const tail = UNASKED_TAILS.find((t) => rest.endsWith(` ${t}`));
			if (
				kind === "turn_unasked" &&
				tail !== undefined &&
				rest.length <= 400 &&
				COUNTED_NAMES.test(rest.slice(0, -(tail.length + 1)).replace(/\.$/, ""))
			) {
				return content;
			}
		}
		return prefix;
	}
	return null;
}
