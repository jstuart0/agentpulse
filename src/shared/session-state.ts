/**
 * Canonical archive-state predicates for session listings.
 *
 * `sessions.isArchived` is the single persisted truth for archival state.
 * `sessions.status` was historically a second write path (frontend wrote
 * `status='archived'` as an optimistic update), but as of Slice G that
 * write is gone. The `'archived'` literal remains in the `SessionStatus`
 * union for backwards-compat with any rows predating this slice; new code
 * never reads or writes that value as the archive signal.
 *
 * Use `isVisibleSession` everywhere a list/filter wants to exclude archived
 * sessions.  Use `isArchivedSession` for the inverse (e.g. the Archived tab).
 */
import { parseStoredTimestamp } from "./timestamp.js";

/**
 * Returns true when the session should appear in ordinary (non-archived)
 * listings.  Structural typing so both full `Session` objects and Drizzle
 * projection shapes (which only select `{ isArchived }`) satisfy it.
 */
export function isVisibleSession(s: { isArchived: boolean }): boolean {
	return !s.isArchived;
}

/**
 * Returns true when the session belongs in the "Archived" view.
 * Inverse of isVisibleSession — keep both to avoid accidental negation bugs
 * at call sites.
 */
export function isArchivedSession(s: { isArchived: boolean }): boolean {
	return s.isArchived;
}

/**
 * Operational status for the dashboard. Four live states plus the
 * "completed" bucket for sessions that are no longer active:
 *
 *   error     → lifecycle failed, and the failure has not been acknowledged
 *   working   → between prompt/tool start and Stop (`isWorking`)
 *   waiting   → needs the operator: a permission prompt is outstanding, or
 *               the agent finished a turn the user has not acknowledged yet
 *   idle      → alive, not working, nothing awaiting the user
 *   completed → archived, or ended for a reason other than an unacknowledged
 *               failure — not in the active set
 *
 * Precedence, in order:
 *   1. `isArchived` → completed, unconditionally — archiving dismisses a
 *      session regardless of lifecycle status or acknowledgement;
 *   2. `status === "failed"`: ERROR while unacknowledged (`lastUserAcknowledgedAt`
 *      is null, or earlier than `endedAt`); completed once acknowledged
 *      (`lastUserAcknowledgedAt` at or after `endedAt`). `markSessionFailed`
 *      always writes `endedAt` in the same update as `status:"failed"`, so a
 *      rule that excluded every ended row before checking `failed` made
 *      ERROR unreachable in practice — this is the fix;
 *   3. otherwise ended (SessionEnd set `endedAt`) or lifecycle `completed`/
 *      `archived` → completed;
 *   4. an OUTSTANDING permission wait (`metadata.permissionWait` with a
 *      non-empty id list or a positive anon count) → waiting, even while
 *      `isWorking` is true. A permission prompt always arrives mid-turn, so
 *      `isWorking` is true for the entire time it's outstanding — checking
 *      `isWorking` before this (the old rule) hid every open prompt as
 *      WORKING. A *resolved* wait (empty ids/anon, or no `permissionWait` at
 *      all) carries no such override;
 *   5. `isWorking` → working. Agent-reported `semanticStatus: "waiting"` can
 *      survive briefly after the agent resumes (it's cleared by the same
 *      late read-modify-write that resolves the permission wait, not
 *      synchronously with `isWorking`), so without an outstanding wait it
 *      yields to the live activity flag;
 *   6. `semanticStatus === "waiting"` → waiting;
 *   7. `lastAgentTurnCompletedAt` is non-null and either unparsable (fails
 *      toward attention, same as the ERROR branch) or newer than
 *      `lastUserAcknowledgedAt` (or no acknowledgement yet) → waiting;
 *   8. otherwise → idle. This also covers a row with no timing data at all
 *      (brand new, or predating the acknowledgement model): nothing has
 *      finished yet, so nothing is awaiting the user.
 *
 * Derived purely from fields the API already returns. `lastActivityAt`,
 * `displayName`, `cwd` and `currentTask` play no part.
 */
export const ACTIVE_OPERATIONAL_STATUSES = ["waiting", "error", "working", "idle"] as const;
export type ActiveOperationalStatus = (typeof ACTIVE_OPERATIONAL_STATUSES)[number];

/**
 * The dashboard's three list tabs, a partition of the sessions in scope:
 * Archived is the archive flag; Completed is not archived and finished (the
 * classifier's "completed" branches); Active is everything else, including
 * quiet sessions waiting on a person and undismissed failures.
 * `GET /sessions?tab=` lists a tab and `tabCounts` in the stats counts it.
 */
export const SESSION_LIST_TABS = ["active", "completed", "archived"] as const;
export type SessionListTab = (typeof SESSION_LIST_TABS)[number];
export type OperationalStatus = ActiveOperationalStatus | "completed";

/** Lower rank sorts first: attention-needing sessions, then working, then the rest. */
export const OPERATIONAL_STATUS_RANK: Record<OperationalStatus, number> = {
	waiting: 0,
	error: 1,
	working: 2,
	idle: 3,
	completed: 4,
};

/** Structural input so both API `Session` rows and test fixtures satisfy it. */
export interface OperationalStatusInput {
	status: string;
	isWorking: boolean;
	isArchived: boolean;
	endedAt: string | null;
	semanticStatus: string | null;
	metadata?: Record<string, unknown> | null;
	lastAgentTurnCompletedAt: string | null;
	lastUserAcknowledgedAt: string | null;
}

/**
 * True when the session is a CANDIDATE for the active operational set: not
 * archived, and either not ended or failed. This is deliberately a superset
 * of "classifies as non-completed" — a failed session that has since been
 * acknowledged is a candidate here (status is still "failed") but
 * `getOperationalStatus` resolves it to "completed". Use this to build the
 * row set to classify (the server's minimal-column candidate query mirrors
 * the same predicate); use `getOperationalStatus(s) !== "completed"` for the
 * exact truth once rows are in hand.
 */
export function isActiveOperationalSession(
	s: Pick<OperationalStatusInput, "status" | "isArchived" | "endedAt">,
): boolean {
	if (s.isArchived || s.status === "archived" || s.status === "completed") return false;
	return s.endedAt == null || s.status === "failed";
}

/**
 * True when the server recorded an explicit permission/input wait.
 * `semanticStatus: "waiting"` is written by applyPermissionWaitTransition
 * together with `metadata.permissionWait`; either signal counts. Evidence
 * only — whether the session IS waiting is decided by getOperationalStatus.
 * Broader than hasOutstandingPermissionWait below: this is true as soon as
 * applyPermissionWaitTransition has ever set `permissionWait`, even once
 * it's resolved to an empty `{ids: [], anon: 0}` (cleared metadata removes
 * the key entirely, but a caller-constructed fixture can still set it).
 */
export function hasExplicitWait(
	s: Pick<OperationalStatusInput, "semanticStatus" | "metadata">,
): boolean {
	return s.semanticStatus === "waiting" || s.metadata?.permissionWait != null;
}

/**
 * True when there is a permission/input wait OUTSTANDING right now: a
 * non-empty id list, or a positive anonymous count. This is the signal that
 * overrides `isWorking` in getOperationalStatus — a prompt that has already
 * been resolved (empty ids/anon) carries no such override, even if
 * `metadata.permissionWait` or a stale `semanticStatus: "waiting"` is still
 * present on the row.
 */
export function hasOutstandingPermissionWait(s: Pick<OperationalStatusInput, "metadata">): boolean {
	const wait = s.metadata?.permissionWait as { ids?: unknown; anon?: unknown } | null | undefined;
	if (wait == null) return false;
	const idCount = Array.isArray(wait.ids) ? wait.ids.length : 0;
	const anonCount = typeof wait.anon === "number" ? wait.anon : 0;
	return idCount > 0 || anonCount > 0;
}

/**
 * True when a failed session's failure has been dismissed: an
 * acknowledgement at or after `endedAt`. `markSessionFailed` always writes
 * `endedAt` in the same update as `status:"failed"`, so a missing `endedAt`
 * on a failed row would be a data anomaly; treated conservatively as
 * "not yet acknowledged" rather than throwing.
 */
export function isFailureAcknowledged(
	s: Pick<OperationalStatusInput, "endedAt" | "lastUserAcknowledgedAt">,
): boolean {
	const ended = parseStoredTimestamp(s.endedAt);
	if (ended === null) return false;
	const ack = parseStoredTimestamp(s.lastUserAcknowledgedAt);
	return ack !== null && ack >= ended;
}

/**
 * True when stamping `lastUserAcknowledgedAt = now` would not change
 * whether the session needs attention for a reason acknowledgement can
 * clear: a finished turn, or a dismissed failure. Used by the acknowledge
 * route to stay idempotent (AGEN) — a no-op call performs no DB write,
 * stores no event, and broadcasts nothing. Deliberately blind to the
 * permission-wait signal, which acknowledging never clears either way, so
 * a session waiting on an outstanding permission prompt is never reported
 * "already acknowledged" just because its turn/failure signal is stale.
 */
export function isAlreadyAcknowledged(
	s: Pick<
		OperationalStatusInput,
		"status" | "endedAt" | "lastAgentTurnCompletedAt" | "lastUserAcknowledgedAt"
	>,
): boolean {
	if (s.status === "failed") return isFailureAcknowledged(s);
	if (s.lastAgentTurnCompletedAt == null) return true; // nothing pending to acknowledge
	const turn = parseStoredTimestamp(s.lastAgentTurnCompletedAt);
	if (turn === null) return false; // present but unparsable — treat as still pending
	const ack = parseStoredTimestamp(s.lastUserAcknowledgedAt);
	return ack !== null && ack >= turn;
}

export function getOperationalStatus(s: OperationalStatusInput): OperationalStatus {
	if (s.isArchived || s.status === "archived") return "completed";
	if (s.status === "failed") return isFailureAcknowledged(s) ? "completed" : "error";
	if (s.endedAt != null || s.status === "completed") return "completed";
	if (hasOutstandingPermissionWait(s)) return "waiting";
	if (s.isWorking) return "working";
	if (s.semanticStatus === "waiting") return "waiting";
	if (s.lastAgentTurnCompletedAt != null) {
		const turn = parseStoredTimestamp(s.lastAgentTurnCompletedAt);
		// Present but unparsable: fail toward attention rather than silently
		// falling through to idle as if no turn had ever completed.
		if (turn === null) return "waiting";
		const ack = parseStoredTimestamp(s.lastUserAcknowledgedAt);
		if (ack === null || turn > ack) return "waiting";
		return "idle";
	}
	// No timing data at all (brand new, or predating the acknowledgement
	// model): nothing has finished yet, so nothing is awaiting the user.
	return "idle";
}

/** True when a human has to act before the session can continue. */
export function needsAttention(s: OperationalStatusInput): boolean {
	const status = getOperationalStatus(s);
	return status === "waiting" || status === "error";
}

/** Per-state counts over the active operational set. Non-active rows are ignored. */
export function countOperationalStatuses(
	sessions: readonly OperationalStatusInput[],
): Record<ActiveOperationalStatus, number> {
	const counts: Record<ActiveOperationalStatus, number> = {
		waiting: 0,
		working: 0,
		idle: 0,
		error: 0,
	};
	for (const s of sessions) {
		const status = getOperationalStatus(s);
		if (status !== "completed") counts[status] += 1;
	}
	return counts;
}

/**
 * Single-select status filter over the active operational set. `null`
 * returns every active session; a status returns only the sessions the
 * classifier puts in that state, so filter, cards and counts always agree.
 */
export function filterByOperationalStatus<T extends OperationalStatusInput>(
	sessions: readonly T[],
	status: ActiveOperationalStatus | null,
): T[] {
	// Not isActiveOperationalSession: that predicate is a candidate superset
	// (a failed-and-acknowledged row still has status:"failed"), so the
	// exact "null = everything active" answer has to go through the
	// classifier itself.
	if (status === null) return sessions.filter((s) => getOperationalStatus(s) !== "completed");
	return sessions.filter((s) => getOperationalStatus(s) === status);
}

/** Sort comparator: attention first, then working, then idle, then completed; ties by recency. */
export function compareOperational(
	a: OperationalStatusInput & { lastActivityAt: string },
	b: OperationalStatusInput & { lastActivityAt: string },
): number {
	const rankDiff =
		OPERATIONAL_STATUS_RANK[getOperationalStatus(a)] -
		OPERATIONAL_STATUS_RANK[getOperationalStatus(b)];
	if (rankDiff !== 0) return rankDiff;
	return (
		(parseStoredTimestamp(b.lastActivityAt) ?? 0) - (parseStoredTimestamp(a.lastActivityAt) ?? 0)
	);
}
