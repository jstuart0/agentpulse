import { isWithinWindow } from "../../shared/time-window.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
/**
 * What a supervisor says about its offline outbox on the heartbeat: how many reports it is holding
 * for later, when the oldest was queued, and what its last flush delivered and lost. It is shown on
 * the Hosts page and returned as `SupervisorRecord.outbox`, so a person can see a host catching up
 * after an outage (and a host that could not keep everything).
 *
 * The body is read tolerantly, like the exclude state: a heartbeat is never rejected because of this
 * field (a rejected heartbeat makes the supervisor exit). Counts are clamped to [0, MAX_COUNT];
 * a time outside the window the server believes (a host with a wrong clock) is dropped to null.
 * A body that cannot be read, or an `outbox` that is not an object of the right shape, changes
 * nothing; a body without `outbox` (an older supervisor, or a host with nothing queued) clears it.
 */
import type { SupervisorOutboxState } from "../../shared/types.js";
import type { HeartbeatBody } from "./supervisor-exclude-state.js";

export const MAX_OUTBOX_COUNT = 10_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A flush or an oldest-queued time is believed from a month back to a few minutes ahead. */
const PAST_MS = 30 * DAY_MS;
const FUTURE_MS = 5 * 60 * 1000;

/** What a heartbeat says to do with the stored outbox state. */
export type OutboxChange =
	| { kind: "set"; value: SupervisorOutboxState }
	| { kind: "clear" }
	| { kind: "leave" };

function count(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(MAX_OUTBOX_COUNT, Math.max(0, Math.trunc(value)));
}

/** A time as normalized ISO inside the believed window, else null. */
function time(value: unknown, nowMs: number): string | null {
	if (!isWithinWindow(value, nowMs, PAST_MS, FUTURE_MS)) return null;
	return new Date(parseStoredTimestamp(value as string) as number).toISOString();
}

/** The outbox object, or null when it is not an object with the five fields in usable form. */
export function parseOutboxObject(
	value: unknown,
	nowMs = Date.now(),
): SupervisorOutboxState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const o = value as Record<string, unknown>;
	const pending = count(o.pending);
	const delivered = count(o.lastFlushDelivered);
	const lost = count(o.lastFlushLost);
	if (pending === null || delivered === null || lost === null) return null;
	for (const key of ["oldestPendingAt", "lastFlushAt"] as const) {
		if (o[key] !== null && typeof o[key] !== "string") return null;
	}
	return {
		pending,
		oldestPendingAt: time(o.oldestPendingAt, nowMs),
		lastFlushAt: time(o.lastFlushAt, nowMs),
		lastFlushDelivered: delivered,
		lastFlushLost: lost,
	};
}

export function parseOutboxState(body: HeartbeatBody, nowMs = Date.now()): OutboxChange {
	if (body.kind === "unreadable") return { kind: "leave" };
	if (body.kind === "empty" || !Object.hasOwn(body.value, "outbox")) return { kind: "clear" };
	const parsed = parseOutboxObject(body.value.outbox, nowMs);
	return parsed ? { kind: "set", value: parsed } : { kind: "leave" };
}

/** The stored column's text as a state, or null when there is none or it is not one. */
export function outboxStateOf(row: object): SupervisorOutboxState | null {
	const text = (row as { outboxState?: unknown }).outboxState;
	if (typeof text !== "string") return null;
	try {
		return parseOutboxObject(JSON.parse(text), Date.now());
	} catch {
		return null;
	}
}

export function sameOutboxState(
	a: SupervisorOutboxState | null,
	b: SupervisorOutboxState | null,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
