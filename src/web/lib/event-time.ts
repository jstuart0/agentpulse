import { LATE_ARRIVAL_MS } from "../../shared/late-arrival.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
/** What the display needs of an event; a server that predates the field sends none. */
type TimedEvent = { createdAt: string; occurredAt?: string | null };

/** Past this many minutes late, the suffix switches to hours. */
const HOURS_AFTER_MIN = 90;

/** When the event happened: the supervisor's own time when it sent one that parses, else when the server stored it. */
export function eventDisplayTime(event: TimedEvent): string {
	return event.occurredAt && parseStoredTimestamp(event.occurredAt) !== null
		? event.occurredAt
		: event.createdAt;
}

/**
 * How many whole minutes beyond LATE_ARRIVAL_MS the event reached the server after it happened, or null
 * when it was not late (no occurrence time, an unreadable time, or no more than LATE_ARRIVAL_MS).
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

/** "arrived 7 min later", or in hours past 90 minutes. */
export function lateSuffix(minutes: number): string {
	if (minutes > HOURS_AFTER_MIN) return `arrived ${Math.round(minutes / 60)} h later`;
	return `arrived ${minutes} min later`;
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
