/**
 * How long a report may sit before it counts as late. A supervisor marks a replay (a report sent from its
 * offline queue or a bridge spool) with a header once it has waited this long, and the dashboard says
 * "arrived N min later" beyond it. Lateness is decided by the authenticated sender's own queueing, never by
 * an event's own timestamp.
 */
export const LATE_ARRIVAL_MS = 60_000;

/**
 * How long the server remembers a delivery id (a receipt): the retention pass deletes a receipt this old. A
 * report sent again after that can no longer be told apart from a new one and is stored again. A sender does
 * not drop a report for its age to avoid that (a possible duplicate beats a certain loss); only the server's
 * retention (`RECEIPT_RETENTION_MS`) uses this constant.
 */
export const DELIVERY_RECEIPT_RETENTION_MS = 72 * 60 * 60 * 1000;
