import type { EventSource } from "./types.js";

export const EVENT_DUPLICATE_WINDOW_MS = 15_000;
export const PROMPT_MIRROR_WINDOW_MS = 8_000;

export const EVENT_SOURCE_PRIORITY: Record<EventSource, number> = {
	observed_transcript: 50,
	observed_status: 40,
	observed_hook: 35,
	managed_control: 20,
	launch_system: 10,
};

export function normalizeComparableContent(content: string | null | undefined) {
	return (content || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseEventTime(value: string | null | undefined) {
	const timestamp = value ? Date.parse(value) : NaN;
	return Number.isFinite(timestamp) ? timestamp : null;
}

export function areNearInTime(left: string | null | undefined, right: string | null | undefined, windowMs: number) {
	const leftMs = parseEventTime(left);
	const rightMs = parseEventTime(right);
	if (leftMs == null || rightMs == null) return false;
	return Math.abs(leftMs - rightMs) <= windowMs;
}

export function getEventSourcePriority(source: EventSource | string | null | undefined) {
	if (!source) return 0;
	return EVENT_SOURCE_PRIORITY[source as EventSource] ?? 0;
}

export function isPromptMirrorSourcePair(left: EventSource | string | null | undefined, right: EventSource | string | null | undefined) {
	return (
		(left === "managed_control" && right === "observed_hook") ||
		(left === "observed_hook" && right === "managed_control")
	);
}
