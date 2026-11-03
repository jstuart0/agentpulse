/**
 * What the server takes in one managed-session report, shared so the sender can keep within it: a batch the
 * server would refuse is lost, so the supervisor shapes what it sends (and what its outbox can keep) to these.
 */

/** The largest request body the managed state and events routes accept. */
export const MANAGED_REPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** The most characters (UTF-16 code units) one event's `content` may hold. */
export const MAX_EVENT_CONTENT_CHARS = 1_000_000;

/** `content` cut to the limit, never in the middle of a surrogate pair. */
export function clampEventContent<T extends string | null | undefined>(content: T): T {
	if (typeof content !== "string" || content.length <= MAX_EVENT_CONTENT_CHARS) return content;
	let end = MAX_EVENT_CONTENT_CHARS;
	const last = content.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return content.slice(0, end) as T;
}
