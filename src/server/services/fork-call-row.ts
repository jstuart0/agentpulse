/**
 * What a continued Claude session's host may put in a row's `rawPayload` (AGEN-122, F14, F51). Every managed
 * event the host marks `claudeStreamRuntime: true` is rebuilt from a whitelist of its kind, so a supervisor bug
 * (or a host that is not what it says it is) can never store a command, path, URL or tool output in a row that
 * team mode shares: the timeline read is not owner-checked, the approval read is.
 *
 * Pure: the same input always gives the same output, and a payload without the marker is returned as it came.
 */
import {
	FORK_CALL_OUTCOMES,
	FORK_TOOL_NAMES,
	type ForkCallOutcome,
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
			typeof tool === "string" &&
			(tool === "mcp" || (FORK_TOOL_NAMES as readonly string[]).includes(tool))
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
export function normalizeForkRowPayload(raw: Record<string, unknown>): Record<string, unknown> {
	if (raw[MARKER_KEY] !== true) return raw;
	const kind = token(raw.kind);
	const common = { source: token(raw.source), kind, [MARKER_KEY]: true };
	if (kind === "call") return compact({ ...common, ...callRow(raw) });
	if (raw.kind === undefined) {
		return compact({ ...common, status: token(raw.status), code: token(raw.code) });
	}
	return compact(common);
}
