/**
 * Limit on how many NEW sessions one person (or, for a key with no owner, one
 * key) may create per minute, in team mode: a stray or hostile key can't flood
 * the dashboard with session rows. Solo is unlimited, as it always was.
 * Generous by default (120) and tunable with AGENTPULSE_SESSION_CREATE_LIMIT;
 * a fixed one-minute window per subject, kept in memory like the hook rate
 * limiter (a restart clears it, and each replica counts for itself).
 *
 * The windows are counted for every real key and the mode is read only when a
 * subject is actually over its limit, so the common creation spends no
 * statement on it. Only a session CREATION asks; events for sessions that
 * already exist never do. Over-limit creations are dropped by the caller with
 * the usual 200.
 */
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

const DEFAULT_LIMIT = 120;
const WINDOW_MS = 60_000;

const counter = new FixedWindowCounter(WINDOW_MS);

/** The per-subject limit: the env value when it is a positive whole number, else the default. */
export function getSessionCreationLimit(): number {
	const raw = process.env.AGENTPULSE_SESSION_CREATE_LIMIT;
	if (raw === undefined || !/^[1-9][0-9]*$/.test(raw.trim())) return DEFAULT_LIMIT;
	return Number(raw.trim());
}

/**
 * What the allowance is counted under: the posting key's owner when it has one
 * (so a person's several keys share it), else the key itself, else nothing (no
 * real key: DISABLE_AUTH or an internal caller, never limited).
 */
export function sessionCreationLimitSubject(attribution: {
	ownerUserId: string | null;
	ingestKeyId: string | null;
}): string | null {
	if (attribution.ownerUserId !== null) return `user:${attribution.ownerUserId}`;
	if (attribution.ingestKeyId !== null) return `key:${attribution.ingestKeyId}`;
	return null;
}

/** True when the subject may create one more session now (and counts it). */
export function tryConsumeSessionCreation(subject: string): boolean {
	return counter.tryConsume(subject, getSessionCreationLimit());
}

/** True the first time an over-limit subject is noted in its window: the caller logs then, once. */
export function noteOverLimitOnce(subject: string): boolean {
	return counter.noteOverLimitOnce(subject);
}

// ── Test-only seams ───────────────────────────────────────────────────────
// Enforced by check-no-test-seam-leaks.ts: these exports may only be
// referenced from a *.test.ts file or test-utils/.
export function _setSessionCreationClockForTest(testClock: (() => number) | null): void {
	counter.setClock(testClock);
}

export function _resetSessionCreationLimitForTest(): void {
	counter.reset();
}

export function _trackedCreationWindowsForTest(): number {
	return counter.trackedSubjects;
}
