import { LATE_ARRIVAL_MS } from "../../shared/late-arrival.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
/** What the display needs of an event; a server that predates the field sends none. */
type TimedEvent = { createdAt: string; occurredAt?: string | null };

/** When the event happened: the supervisor's own time when it sent one that parses, else when the server stored it. */
export function eventDisplayTime(event: TimedEvent): string {
	return event.occurredAt && parseStoredTimestamp(event.occurredAt) !== null
		? event.occurredAt
		: event.createdAt;
}

/**
 * How many whole minutes (at least 1) after it happened the server stored the event, or null when it was
 * not late: no occurrence time, an unreadable time, or no more than LATE_ARRIVAL_MS after it happened.
 * Display only: it never decides anything.
 */
export function lateArrival(event: TimedEvent): number | null {
	const occurred = parseStoredTimestamp(event.occurredAt ?? undefined);
	const stored = parseStoredTimestamp(event.createdAt);
	if (occurred === null || stored === null) return null;
	const lateMs = stored - occurred;
	if (lateMs <= LATE_ARRIVAL_MS) return null;
	return Math.max(1, Math.floor(lateMs / 60_000));
}

/** "arrived 7m late", "arrived 1h 31m late", in the units the relative times use (floored). */
export function lateSuffix(minutes: number): string {
	if (minutes < 60) return `arrived ${minutes}m late`;
	if (minutes < 24 * 60) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return `arrived ${rest ? `${hours}h ${rest}m` : `${hours}h`} late`;
	}
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor((minutes % (24 * 60)) / 60);
	return `arrived ${hours ? `${days}d ${hours}h` : `${days}d`} late`;
}

const whenFormat = () =>
	new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
	});

/** "Happened Sun 2 Nov, 14:02 · reached AgentPulse Sun 2 Nov, 14:09" for a late event, else null. */
export function lateDetail(event: TimedEvent): string | null {
	if (lateArrival(event) === null) return null;
	const format = whenFormat();
	const happened = parseStoredTimestamp(event.occurredAt ?? undefined) as number;
	const reached = parseStoredTimestamp(event.createdAt) as number;
	return `Happened ${format.format(new Date(happened))} · reached AgentPulse ${format.format(new Date(reached))}`;
}

/** A value for <time dateTime>: ISO when it parses (the stored form has no T or Z), else as given. */
export function timeAttribute(iso: string): string {
	const ms = parseStoredTimestamp(iso);
	return ms === null ? iso : new Date(ms).toISOString();
}

/**
 * The index of each row that starts a run of late rows, over the rows given (the ones on screen after
 * filtering): a late row whose previous visible row is not late. Rows stay in id order, so occurrence times
 * can run backwards across a run; that is intended.
 */
export function lateRunStarts(rows: TimedEvent[]): Set<number> {
	const starts = new Set<number>();
	let previousLate = false;
	rows.forEach((row, index) => {
		const late = lateArrival(row) !== null;
		if (late && !previousLate) starts.add(index);
		previousLate = late;
	});
	return starts;
}
