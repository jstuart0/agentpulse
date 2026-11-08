/**
 * When a continued session's row can offer "Details", and what its panel says (AGEN-123). Pure functions, so
 * each rule is tested without rendering.
 *
 * A row lands before its detail does (the host sends detail a moment after the result), so a row whose detail
 * hasn't arrived shows nothing at all while its turn runs: no control, and no claim that it wasn't captured.
 * The control appears when a refetch finds the record. "Wasn't captured" is said only for a call whose turn
 * ended more than a minute ago.
 */
import type { ForkToolCallIndexEntry } from "../../../shared/fork-tool-calls.js";
import type { SessionEvent } from "../../../shared/types.js";
import type { ToolDetailAccess } from "../../lib/session-action-access.js";

/** A detail still missing this long after its turn ended will not arrive. */
export const NOT_CAPTURED_AFTER_MS = 60_000;
/** How often the list is read again while the fork's turn is running. */
export const DETAIL_POLL_MS = 5_000;
/** The events that bound a turn: its start and its two ends. */
const TURN_BOUNDARY_EVENTS = new Set([
	"HeadlessPromptSubmitted",
	"HeadlessPromptCompleted",
	"HeadlessPromptFailed",
]);
const TURN_END_EVENTS = new Set(["HeadlessPromptCompleted", "HeadlessPromptFailed"]);

type RowEvent = Pick<SessionEvent, "eventType" | "createdAt"> &
	Partial<Pick<SessionEvent, "rawPayload">>;

/** The `tool_use_id` a fork's per-call row carries, or null when the event is not such a row. */
export function callRowToolUseId(event: RowEvent): string | null {
	if (event.eventType !== "HeadlessStatus") return null;
	const raw = event.rawPayload;
	if (!raw || raw.source !== "claude_stream" || raw.kind !== "call") return null;
	return typeof raw.tool_use_id === "string" && raw.tool_use_id !== "" ? raw.tool_use_id : null;
}

/**
 * The calls of the turn the summary row at `index` closes: the per-call rows between the previous turn
 * boundary and the summary row, in order. Events are in id order, as the page holds them.
 */
export function turnCallIds(events: readonly RowEvent[], index: number): string[] {
	const ids: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const event = events[i] as RowEvent;
		if (TURN_BOUNDARY_EVENTS.has(event.eventType)) break;
		const id = callRowToolUseId(event);
		if (id !== null) ids.unshift(id);
	}
	return ids;
}

/**
 * When the turn a row belongs to ended, in ms: the next turn-end event after the row, else the row's own
 * time when the session is not working (the end event is not on screen), else null (the turn is running).
 */
export function turnEndedAtMs(
	events: readonly RowEvent[],
	index: number,
	sessionWorking: boolean,
): number | null {
	for (let i = index + 1; i < events.length; i++) {
		const event = events[i] as RowEvent;
		if (TURN_END_EVENTS.has(event.eventType)) return Date.parse(event.createdAt);
		if (event.eventType === "HeadlessPromptSubmitted") break;
	}
	if (sessionWorking) return null;
	return Date.parse((events[index] as RowEvent).createdAt);
}

/** What the panel says when the read for one call finds nothing. */
export function missingDetailState(
	turnEndedAt: number | null,
	nowMs: number,
): "arriving" | "not_captured" {
	if (turnEndedAt === null || Number.isNaN(turnEndedAt)) return "arriving";
	return nowMs - turnEndedAt > NOT_CAPTURED_AFTER_MS ? "not_captured" : "arriving";
}

/** The records by tool-use id; a record for the same call twice keeps the first. */
export function indexCalls(
	calls: readonly ForkToolCallIndexEntry[],
): ReadonlyMap<string, ForkToolCallIndexEntry> {
	const map = new Map<string, ForkToolCallIndexEntry>();
	for (const call of calls) if (!map.has(call.toolUseId)) map.set(call.toolUseId, call);
	return map;
}

// ---- words ----

export const DETAIL_BUTTON = "Details";
export const TURN_DETAIL_BUTTON = "Show what ran";
export const DETAIL_INPUT_HEADING = "Input";
export const DETAIL_OUTPUT_HEADING = "Output";
export const DETAIL_NOT_CAPTURED = "Details weren't captured for this call.";
export const DETAIL_ARRIVING = "Details are still arriving.";
export const DETAIL_FORBIDDEN = "Only the owner or an admin can see what this ran.";
export const DETAIL_LOAD_FAILED = "Couldn't load the details.";
export const DETAIL_REDACTED = "Some text that looked like a secret was hidden.";
export const DETAIL_TRUNCATED = "Only the first 16 KB is shown.";
export const DETAIL_KEPT = "Kept for 7 days.";

/** The accessible name of a row's disclosure: what the screen reader says for "Details". */
export const detailButtonLabel = (tool: string): string => `Show what ${tool} ran`;

/** The line an admin reading someone else's detail sees. `ownerName` null: the session has no owner. */
export function adminOnOthersLine(ownerName: string | null): string {
	return ownerName
		? `This is ${ownerName}'s session. Only they and admins can see this.`
		: "This session has no owner. Only admins can see this.";
}

/** The note above the text, by who is reading; null for the owner (and for solo). */
export function accessNote(access: ToolDetailAccess, ownerName: string | null): string | null {
	return access === "admin_on_others" ? adminOnOthersLine(ownerName) : null;
}
