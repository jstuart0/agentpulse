/**
 * Module-level ingest counters.
 *
 * Kept in a dedicated module to avoid circular imports between
 * ingest.ts and hook-rate-limit.ts. Both import from here; neither
 * imports the other for counter access.
 *
 * Counters are in-process only (reset on restart). They are surfaced
 * via GET /api/v1/health for operational observability.
 */

let bgErrorCount = 0;
let inFlightCount = 0;
let rateLimitedDropped = 0;
let oversizeDropped = 0;
let ingestOwnerMismatch = 0;
let ingestUnacknowledgeDropped = 0;
let ingestForeignKeyDropped = 0;
let sessionCreationLimited = 0;
let ingestKeyBound = 0;

export function getBgErrorCount(): number {
	return bgErrorCount;
}
export function incrementBgErrorCount(): void {
	bgErrorCount++;
}

export function getInFlightCount(): number {
	return inFlightCount;
}
export function incrementInFlightCount(): void {
	inFlightCount++;
}
export function decrementInFlightCount(): void {
	if (inFlightCount > 0) {
		inFlightCount--;
	} else {
		// Guard against double-decrement: counter stays at 0 rather than going
		// negative, which would permanently stall the preStop drain poll.
		console.warn(JSON.stringify({ kind: "inflight_underflow_guard", level: "warn" }));
	}
}

export function getRateLimitedDropped(): number {
	return rateLimitedDropped;
}
export function incrementRateLimitedDropped(): void {
	rateLimitedDropped++;
}

/** D16 (F116): count of hook bodies dropped for exceeding the size cap. */
export function getOversizeDropped(): number {
	return oversizeDropped;
}
export function incrementOversizeDropped(): void {
	oversizeDropped++;
}

/**
 * A session's owner and a posting key's owner disagree, both non-null.
 * Free to compute (both values are already in memory at the write site) —
 * kept because it's a useful ownership-fight signal, not because it costs
 * anything.
 */
export function getIngestOwnerMismatchCount(): number {
	return ingestOwnerMismatch;
}
export function incrementIngestOwnerMismatch(): void {
	ingestOwnerMismatch++;
}

/**
 * "Mark as unseen" is never hook-reachable (AGEN security): a
 * `UserUnacknowledge` event posted to the hook endpoint is dropped
 * unconditionally, regardless of ownership, before it touches the
 * database. This is a separate count from ingestOwnerMismatch because the
 * drop has nothing to do with ownership — every UserUnacknowledge hook
 * delivery is dropped, owned, unowned, or matching.
 */
export function getIngestUnacknowledgeDroppedCount(): number {
	return ingestUnacknowledgeDropped;
}
export function incrementIngestUnacknowledgeDropped(): void {
	ingestUnacknowledgeDropped++;
}

/**
 * In team mode, a hook event (or native-name write) for an owned session from
 * a key that isn't the owner's (or the session's recorded ingest key) is
 * dropped: answered 200, nothing stored. Counted here so a teammate's stray or
 * hostile key is observable.
 */
export function getIngestForeignKeyDroppedCount(): number {
	return ingestForeignKeyDropped;
}
export function incrementIngestForeignKeyDropped(): void {
	ingestForeignKeyDropped++;
}

/**
 * In team mode, the first event of a session that had no recorded ingest key,
 * from an ownerless key, records that key as the session's own. Counted so a
 * shared key attaching itself to sessions is observable.
 */
export function getIngestKeyBoundCount(): number {
	return ingestKeyBound;
}
export function incrementIngestKeyBound(): void {
	ingestKeyBound++;
}

/** New sessions dropped because the posting key went over its per-minute creation limit. */
export function getSessionCreationLimitedCount(): number {
	return sessionCreationLimited;
}
export function incrementSessionCreationLimited(): void {
	sessionCreationLimited++;
}

/** Reset all counters — for use in tests only. */
export function _resetCountersForTest(): void {
	bgErrorCount = 0;
	inFlightCount = 0;
	rateLimitedDropped = 0;
	oversizeDropped = 0;
	ingestOwnerMismatch = 0;
	ingestUnacknowledgeDropped = 0;
	ingestForeignKeyDropped = 0;
	sessionCreationLimited = 0;
	ingestKeyBound = 0;
}

/** Reset only the mismatch counter — for use in tests only. */
export function _resetIngestOwnerMismatchForTest(): void {
	ingestOwnerMismatch = 0;
}

/** Reset only the unacknowledge-dropped counter — for use in tests only. */
export function _resetIngestUnacknowledgeDroppedForTest(): void {
	ingestUnacknowledgeDropped = 0;
}
