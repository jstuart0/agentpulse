/**
 * A summary request can start a paid model call, so a caller (the signed-in
 * person, or the key when it has no owner, or the one DISABLE_AUTH operator) may
 * ask only a handful of times a minute, whatever the answer was. In memory: a
 * restart clears it and each replica counts for itself.
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export const SUMMARY_REQUEST_LIMIT_PER_MINUTE = 6;
const WINDOW_MS = 60_000;

const counter = new FixedWindowCounter(WINDOW_MS);

/** True when the caller may make one more summary request now (and counts it). */
export function tryConsumeSummaryRequest(subject: string): boolean {
	return counter.tryConsume(subject, SUMMARY_REQUEST_LIMIT_PER_MINUTE);
}

/** Whole seconds until the caller's window ends, at least 1: the `Retry-After` of a limited request. */
export function summaryRetryAfterSeconds(subject: string): number {
	return Math.max(1, Math.ceil(counter.msUntilWindowEnds(subject) / 1000));
}

// ── Test-only seams ───────────────────────────────────────────────────────
// Enforced by check-no-test-seam-leaks.ts: these exports may only be
// referenced from a *.test.ts file or test-utils/.
export function _resetSummaryLimitForTest(): void {
	counter.reset();
}

export function _setSummaryLimitClockForTest(clock: (() => number) | null): void {
	counter.setClock(clock);
}
