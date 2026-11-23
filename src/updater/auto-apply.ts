/**
 * What an automatic run does with how it ended: which endings are failures, how long a run of failures holds
 * the next attempt back, and which endings are only "not yet". All pure, over an injected clock.
 *
 * The scheduled job fires every six hours; a failure holds the next attempt back for 1 h, then 6 h, then 24 h
 * (`BACKOFF_MS`), counted in a row and reset by a run that updated or found nothing to do. Endings that mean
 * "the conditions aren't met yet" (a busy supervisor, a window that hasn't opened, a release still waiting out
 * its 24 hours) are not failures: they count for nothing and hold nothing back. A version that failed after the
 * install was touched is never tried again (`refused`, in state.ts), whatever the backoff says.
 */
import type { UpdaterState } from "../shared/update-files.js";
import type { UpdateOutcomeCode } from "../shared/update-status.js";

const HOUR_MS = 3_600_000;
/** Held back after the first, second and every later failure in a row. */
export const BACKOFF_MS = [HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS] as const;

/** Endings that count toward the backoff: something broke, or couldn't be verified or prepared. */
const FAILURE_CODES: ReadonlySet<UpdateOutcomeCode> = new Set<UpdateOutcomeCode>([
	"unverified",
	"stale",
	"server_version_unknown",
	"no_service_manager",
	"symlinked_install",
	"dirty_tree",
	"untracked_files",
	"disk_space",
	"not_fast_forward",
	"commit_mismatch",
	"db_path_mismatch",
	"install_failed",
	"build_failed",
	"smoke_failed",
	"snapshot_failed",
	"drain_timeout",
	"stop_failed",
	"health_failed",
	"supervisor_failed",
	"rolled_back",
	"rollback_failed",
]);

/** Endings that mean "not yet": no failure, no backoff, and `waitingSince` marks when it began. */
const WAITING_CODES: ReadonlySet<UpdateOutcomeCode> = new Set<UpdateOutcomeCode>([
	"supervisor_busy",
	"outside_window",
	"canary_wait",
]);

export function isAutoFailure(code: UpdateOutcomeCode): boolean {
	return FAILURE_CODES.has(code);
}

export function isWaiting(code: UpdateOutcomeCode): boolean {
	return WAITING_CODES.has(code);
}

/** Endings that clear the run of failures: an update, or nothing left to do. */
function clearsFailures(code: UpdateOutcomeCode): boolean {
	return code === "updated" || code === "up_to_date";
}

export function backoffActive(state: Pick<UpdaterState, "backoff">, nowMs: number): boolean {
	if (!state.backoff) return false;
	const until = Date.parse(state.backoff.notBefore);
	return Number.isFinite(until) && nowMs < until;
}

/** The backoff after a run ended with `code`: bumped by a failure, cleared by a success, otherwise unchanged. */
export function nextBackoff(
	current: UpdaterState["backoff"],
	code: UpdateOutcomeCode,
	nowMs: number,
): UpdaterState["backoff"] | null {
	if (clearsFailures(code)) return null;
	if (!isAutoFailure(code)) return current ?? null;
	const failures = (current?.failures ?? 0) + 1;
	const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] as number;
	return { failures, notBefore: new Date(nowMs + wait).toISOString() };
}
