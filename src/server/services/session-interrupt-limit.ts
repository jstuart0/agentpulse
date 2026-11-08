/**
 * Stop turn (AGEN-119) runs nothing, but each press sends a control request to a host, so the route counts
 * six a minute per caller (the person, else the key), before anything is looked up. In memory, per process,
 * like the other limiters.
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export const SESSION_INTERRUPT_LIMIT_PER_MINUTE = 6;
const WINDOW_MS = 60_000;

const counter = new FixedWindowCounter(WINDOW_MS);

/** True when the caller may stop one more turn now (and counts it). */
export function tryConsumeSessionInterrupt(subject: string): boolean {
	return counter.tryConsume(subject, SESSION_INTERRUPT_LIMIT_PER_MINUTE);
}

/** Whole seconds until the caller's window ends, at least 1: the `Retry-After` of a 429. */
export function sessionInterruptRetryAfterSeconds(subject: string): number {
	return Math.max(1, Math.ceil(counter.msUntilWindowEnds(subject) / 1000));
}

// ── Test-only seams (check-no-test-seam-leaks.ts) ─────────────────────────
export function _resetSessionInterruptLimitForTest(): void {
	counter.reset();
}

export function _setSessionInterruptClockForTest(clock: (() => number) | null): void {
	counter.setClock(clock);
}
