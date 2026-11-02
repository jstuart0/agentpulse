/**
 * How long a report may sit before it counts as late. A supervisor marks a replay (a report sent from its
 * offline queue or a bridge spool) with a header once it has waited this long, and the dashboard says
 * "arrived N min later" beyond it. Lateness is decided by the authenticated sender's own queueing, never by
 * an event's own timestamp.
 */
export const LATE_ARRIVAL_MS = 60_000;
