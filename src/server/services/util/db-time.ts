// The one server-side normalizer for timestamps read from the events table.
// SQLite stores `datetime('now')` as a bare UTC "YYYY-MM-DD HH:MM:SS"; a
// plain Date.parse reads that as local time, which is wrong on any host not
// running in UTC. Postgres stores CURRENT_TIMESTAMP text with an offset.
//
// The actual parsing rule lives in src/shared/timestamp.ts (shared with the
// browser and the operational-status classifier) — this just re-exports it
// under the name existing callers already use.
export { parseStoredTimestamp as parseDbTimestamp } from "../../../shared/timestamp.js";

/** Formats a Date in the SQLite column format: UTC, truncated to the second. */
export function toDbTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}
