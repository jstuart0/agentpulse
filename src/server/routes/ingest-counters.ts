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
	inFlightCount--;
}

export function getRateLimitedDropped(): number {
	return rateLimitedDropped;
}
export function incrementRateLimitedDropped(): void {
	rateLimitedDropped++;
}

/** Reset all counters — for use in tests only. */
export function _resetCountersForTest(): void {
	bgErrorCount = 0;
	inFlightCount = 0;
	rateLimitedDropped = 0;
}
