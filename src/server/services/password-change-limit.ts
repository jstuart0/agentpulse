/**
 * Failed current-password attempts on POST /auth/change-password, counted per
 * user: the endpoint is reachable with a stolen session cookie, so it must not
 * be a way to guess the current password. In memory (a restart clears it, and
 * each replica counts for itself).
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export const PASSWORD_CHANGE_FAILURE_LIMIT = 5;
export const PASSWORD_CHANGE_WINDOW_MS = 15 * 60_000;

const counter = new FixedWindowCounter(PASSWORD_CHANGE_WINDOW_MS);

/** Seconds until the user may try again, or null when they aren't locked out. */
export function passwordChangeRetryAfterSeconds(userId: string): number | null {
	if (!counter.isAtLimit(userId, PASSWORD_CHANGE_FAILURE_LIMIT)) return null;
	return Math.max(1, Math.ceil(counter.msUntilWindowEnds(userId) / 1000));
}

/** Counts one failed current-password attempt. */
export function recordPasswordChangeFailure(userId: string): void {
	counter.tryConsume(userId, PASSWORD_CHANGE_FAILURE_LIMIT);
}

/** A successful change forgets the user's earlier failures. */
export function clearPasswordChangeFailures(userId: string): void {
	counter.clear(userId);
}

// ── Test-only seams ───────────────────────────────────────────────────────
// Enforced by check-no-test-seam-leaks.ts: these exports may only be
// referenced from a *.test.ts file or test-utils/.
export function _resetPasswordChangeLimitForTest(): void {
	counter.reset();
}

export function _setPasswordChangeClockForTest(clock: (() => number) | null): void {
	counter.setClock(clock);
}
