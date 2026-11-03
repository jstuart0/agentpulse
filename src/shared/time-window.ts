import { parseStoredTimestamp } from "./timestamp.js";

/**
 * True when `value` parses as a stored timestamp inside
 * [nowMs - pastMs, nowMs + futureMs] (both ends inclusive). Anything that
 * doesn't parse, or isn't a string, is outside.
 */
export function isWithinWindow(
	value: unknown,
	nowMs: number,
	pastMs: number,
	futureMs: number,
): boolean {
	if (typeof value !== "string") return false;
	const ms = parseStoredTimestamp(value);
	if (ms === null) return false;
	return ms >= nowMs - pastMs && ms <= nowMs + futureMs;
}
