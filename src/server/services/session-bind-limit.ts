/**
 * Taking over or resuming a session starts a process on someone's machine, so the two routes share one small
 * budget per caller: ten attempts a minute across both, counted before anything is looked up (a refusal costs
 * one too, so the routes are no way to probe). In memory, per process, like the other limiters.
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export const SESSION_BIND_LIMIT_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

const counter = new FixedWindowCounter(WINDOW_MS);

/** True when the caller may try one more now (and counts it). */
export function tryConsumeSessionBind(subject: string): boolean {
	return counter.tryConsume(subject, SESSION_BIND_LIMIT_PER_MINUTE);
}

// ── Test-only seams (check-no-test-seam-leaks.ts) ─────────────────────────
export function _resetSessionBindLimitForTest(): void {
	counter.reset();
}

export function _setSessionBindClockForTest(clock: (() => number) | null): void {
	counter.setClock(clock);
}
