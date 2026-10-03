/**
 * Minting API keys is rare, so it is limited hard: a caller (the signed-in
 * person, or the key when it has no owner) may mint a handful a minute. A
 * leaked or runaway credential can't fill the key table, and the admin lock a
 * mint takes isn't a way to starve everything else.
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

export const KEY_MINT_LIMIT_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

const counter = new FixedWindowCounter(WINDOW_MS);

/** True when the caller may mint one more key now (and counts it). */
export function tryConsumeKeyMint(subject: string): boolean {
	return counter.tryConsume(subject, KEY_MINT_LIMIT_PER_MINUTE);
}

// ── Test-only seams ───────────────────────────────────────────────────────
// Enforced by check-no-test-seam-leaks.ts: these exports may only be
// referenced from a *.test.ts file or test-utils/.
export function _resetKeyMintLimitForTest(): void {
	counter.reset();
}

export function _setKeyMintClockForTest(clock: (() => number) | null): void {
	counter.setClock(clock);
}
