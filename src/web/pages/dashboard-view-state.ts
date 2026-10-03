/**
 * Pure derivation logic for the dashboard. Nothing here touches the DOM,
 * fetch, or a store — components call these functions and render the
 * result. Mirrors the pattern in hosts-view-state.ts: boundary cases get
 * example-based tests instead of relying on a browser to exercise them.
 */
import {
	type OperationalStatus,
	type OperationalStatusInput,
	getOperationalStatus,
	hasOutstandingPermissionWait,
} from "../../shared/session-state.js";

// ── List view: server-paged rows for the selected status card ──────────────

export interface ListViewInput<T> {
	/** Rows loaded so far for the current filter (accumulated across "Load more" pages). */
	loadedRows: readonly T[];
	/**
	 * The authoritative total for the current filter. For a selected status
	 * card this is the server's per-status count (DashboardStats.operational);
	 * with no status selected it's the server's list `total`. `null` means
	 * no authoritative count has arrived yet (first load) — the derivation
	 * falls back to `loadedRows.length` so a page that hasn't been told the
	 * truth yet still renders the rows it has, rather than looking empty.
	 */
	total: number | null;
	/** DashboardStats.truncated — the operational candidate scan hit its cap. */
	truncated: boolean;
}

export interface ListView<T> {
	rows: readonly T[];
	/** e.g. "Showing 20 of 143". */
	showingText: string;
	canLoadMore: boolean;
	truncated: boolean;
	/**
	 * True only when the authoritative total is actually zero. Never true
	 * just because `loadedRows` hasn't arrived yet — a selected status with
	 * count > 0 must never flash an empty state while its page is loading.
	 */
	isEmpty: boolean;
}

export function deriveListView<T>(input: ListViewInput<T>): ListView<T> {
	const total = input.total ?? input.loadedRows.length;
	const canLoadMore = input.loadedRows.length < total;
	const isEmpty = total === 0;
	return {
		rows: input.loadedRows,
		showingText: `Showing ${input.loadedRows.length} of ${total}`,
		canLoadMore,
		truncated: input.truncated,
		isEmpty,
	};
}

// ── Tab badge counts ────────────────────────────────────────────────────────

// ── Optimistic acknowledge / unacknowledge ──────────────────────────────────

export type AckAction = "acknowledge" | "unacknowledge";

/** The optimistic next value for `lastUserAcknowledgedAt`, applied immediately on click. */
export function nextAckState<T extends { lastUserAcknowledgedAt: string | null }>(
	session: T,
	action: AckAction,
	nowIso: string,
): T {
	return { ...session, lastUserAcknowledgedAt: action === "acknowledge" ? nowIso : null };
}

/**
 * Rollback is just "the object exactly as it was before the optimistic
 * update" — identity-preserving on purpose (no merge), so a rollback can
 * never accidentally reintroduce a different optimistic field.
 */
export function rollbackAckState<T>(previous: T): T {
	return previous;
}

export type AckAttemptOutcome = "applied" | "not_owner" | "failed";

/**
 * Classifies the server's acknowledge/unacknowledge response (or a thrown
 * error, passed as `null`) into one of three outcomes a caller can branch
 * on without re-deriving the `acknowledged`/`unacknowledged` field name
 * difference between the two endpoints.
 */
export function classifyAckResponse(
	result: { acknowledged?: boolean; unacknowledged?: boolean; reason?: string } | null,
): AckAttemptOutcome {
	if (!result) return "failed";
	const applied = result.acknowledged ?? result.unacknowledged ?? false;
	if (applied) return "applied";
	if (result.reason === "not_owner") return "not_owner";
	return "failed";
}

// ── Mark all as seen ────────────────────────────────────────────────────────

/**
 * Splits a waiting-session set into those "Mark all as seen" may actually
 * act on, and counts of why the rest are excluded. A session with an
 * outstanding permission prompt is excluded the same way a non-owned
 * session is (AGEN) — acknowledging it can never clear WAITING (see
 * deriveAckAction), so it must never count toward "N of M" or be a mark-all
 * target. `hasOutstandingWait` defaults to always-false so existing callers
 * that only care about ownership don't have to pass it.
 */
export function selectMarkAllTargets<T>(
	waitingSessions: readonly T[],
	canAcknowledge: (session: T) => boolean,
	hasOutstandingWait: (session: T) => boolean = () => false,
): { targets: T[]; skippedNotOwner: number; skippedPermissionWait: number } {
	const targets: T[] = [];
	let skippedNotOwner = 0;
	let skippedPermissionWait = 0;
	for (const s of waitingSessions) {
		if (hasOutstandingWait(s)) {
			skippedPermissionWait += 1;
		} else if (canAcknowledge(s)) {
			targets.push(s);
		} else {
			skippedNotOwner += 1;
		}
	}
	return { targets, skippedNotOwner, skippedPermissionWait };
}

/** Splits `items` into chunks of at most `size`, preserving order — the batching unit for "mark all". */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (size <= 0) throw new Error(`chunk size must be > 0, got ${size}`);
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export interface MarkAllSummary {
	/** Successfully acknowledged. */
	done: number;
	/** Not attempted (viewer isn't the owner) or rejected by the server as not_owner. */
	skippedNotOwner: number;
	/** Not attempted — an outstanding permission prompt overrides WAITING; see deriveAckAction. */
	skippedPermissionWait: number;
	/** Attempted but failed for another reason (network error, etc). */
	failed: number;
	totalWaiting: number;
}

export function summarizeMarkAll(params: {
	totalWaiting: number;
	preSkippedNotOwner: number;
	preSkippedPermissionWait?: number;
	outcomes: readonly AckAttemptOutcome[];
}): MarkAllSummary {
	let done = 0;
	let failed = 0;
	let notOwnerDuringAttempt = 0;
	for (const o of params.outcomes) {
		if (o === "applied") done += 1;
		else if (o === "not_owner") notOwnerDuringAttempt += 1;
		else failed += 1;
	}
	return {
		done,
		skippedNotOwner: params.preSkippedNotOwner + notOwnerDuringAttempt,
		skippedPermissionWait: params.preSkippedPermissionWait ?? 0,
		failed,
		totalWaiting: params.totalWaiting,
	};
}

// ── Auto-acknowledge gate (session detail page) ─────────────────────────────

/** Minimum time the detail page must have been open and visible before it auto-acknowledges. */
export const AUTO_ACK_DWELL_MS = 2000;

export interface AutoAckGateInput {
	operationalStatus: OperationalStatus;
	canAcknowledge: boolean;
	tabVisible: boolean;
	/** Milliseconds the session's detail page has been open AND visible, continuously. */
	dwellMs: number;
	/** True once this turn has already been auto-acknowledged (guards re-firing on every poll/WS update). */
	alreadyAckedThisTurn: boolean;
}

/**
 * Opening a session's detail page marks it seen only when every condition
 * holds: WAITING (never ERROR — that needs an explicit dismiss), the
 * viewer may acknowledge it, the tab is actually visible (a background or
 * restored tab must not fire), the dwell time has elapsed, and it hasn't
 * already happened for this turn.
 */
export function shouldAutoAcknowledge(input: AutoAckGateInput): boolean {
	return (
		input.operationalStatus === "waiting" &&
		input.canAcknowledge &&
		input.tabVisible &&
		input.dwellMs >= AUTO_ACK_DWELL_MS &&
		!input.alreadyAckedThisTurn
	);
}

// ── Stable group ordering ────────────────────────────────────────────────────

export interface SessionGroup<T> {
	key: string;
	label: string;
	sessions: T[];
	pinned: boolean;
}

/**
 * Groups `sessions` by `keyOf` and orders the groups pinned-first, then by
 * label — never by urgency (urgency is carried by the per-project chips and
 * the status filter, not by reordering the groups out from under the
 * person reading them). `keyOf` is what changes to group by something other
 * than project (agent type, owner); `compareGroups` replaces the
 * pinned-then-label order where a grouping has its own (people: you first).
 */
export function groupSessionsStable<T>(
	sessions: readonly T[],
	keyOf: (session: T) => string,
	labelOf: (key: string) => string,
	isPinned: (session: T) => boolean,
	compareGroups?: (a: SessionGroup<T>, b: SessionGroup<T>) => number,
): SessionGroup<T>[] {
	const groups = new Map<string, T[]>();
	for (const session of sessions) {
		const key = keyOf(session);
		const existing = groups.get(key);
		if (existing) existing.push(session);
		else groups.set(key, [session]);
	}
	const entries: SessionGroup<T>[] = Array.from(groups.entries()).map(([key, items]) => ({
		key,
		label: labelOf(key),
		sessions: items,
		pinned: items.some(isPinned),
	}));
	entries.sort(
		compareGroups ??
			((a, b) => {
				if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
				return a.label.localeCompare(b.label);
			}),
	);
	return entries;
}

/** The default (and currently only) grouping key: project, keyed by cwd. */
export function groupByProjectKey(session: { cwd: string | null }): string {
	return session.cwd || "Unknown";
}

// ── Held sort order (cards must not jump mid-interaction) ──────────────────

/**
 * Reconciles a "held" display order against a fresh sort (AGEN). While a
 * card is being hovered/focused, or is showing its post-action Undo
 * banner, a status change (e.g. WAITING -> IDLE on acknowledge) must not
 * move it under the pointer or out from under the Undo button. The
 * caller decides WHEN to hold (hover/focus state, or "did this session's
 * sort-relevant fields change within the Undo window" — both need a
 * timer/DOM and so live in the component, not here); this function only
 * decides the resulting ORDER once that's known:
 *
 *   - ids already in `previousOrder` keep their previous relative order
 *     (dropped if no longer present in `freshSortedIds` at all);
 *   - ids new to this render (not in `previousOrder`) are appended in
 *     their fresh-sort relative order.
 *
 * Passing an empty `previousOrder` (the "not held" case) is equivalent to
 * using `freshSortedIds` directly — every id is "new".
 */
export function reconcileHeldOrder(
	previousOrder: readonly string[],
	freshSortedIds: readonly string[],
): string[] {
	const previousSet = new Set(previousOrder);
	const currentSet = new Set(freshSortedIds);
	const kept = previousOrder.filter((id) => currentSet.has(id));
	const added = freshSortedIds.filter((id) => !previousSet.has(id));
	return [...kept, ...added];
}

// ── Shared "Undo" window ────────────────────────────────────────────────────

/**
 * How long a post-action "Marked as seen · Undo" / "Error dismissed · Undo"
 * banner or toast stays before the row settles into its new state — one
 * constant shared by SessionCard's inline banner, SessionDetailPage's
 * toast, and the "Mark all as seen" bulk-undo toast, so the three surfaces
 * can never drift to different windows.
 */
export const UNDO_WINDOW_MS = 5000;

// ── Acknowledge-action derivation (card + detail header) ────────────────────

export type AckActionKind = "mark_seen" | "dismiss_error" | "mark_unseen" | "restore_error";

/** One label per action kind (AGEN) — the single source SessionCard and SessionHeader both read, so the two surfaces can't drift apart in wording. */
export const ACK_ACTION_LABEL: Record<AckActionKind, string> = {
	mark_seen: "Mark as seen",
	dismiss_error: "Dismiss error",
	restore_error: "Restore error",
	mark_unseen: "Mark as unseen",
};

/** Longest owner name shown in a button; the full name stays in the accessible label. */
const MAX_OWNER_IN_LABEL = 24;

/** The button's text; an admin acting on someone else's session sees whose it is. */
export function ackActionLabel(kind: AckActionKind, forOwnerName?: string | null): string {
	const base = ACK_ACTION_LABEL[kind];
	if (!forOwnerName || (kind !== "mark_seen" && kind !== "dismiss_error")) return base;
	const shown =
		forOwnerName.length > MAX_OWNER_IN_LABEL
			? `${forOwnerName.slice(0, MAX_OWNER_IN_LABEL - 1)}…`
			: forOwnerName;
	return `${base} for ${shown}`;
}

/** The toast after an explicit acknowledge on the detail page; an admin acting for someone is told for whom. */
export function ackToastText(kind: AckActionKind, forOwnerName?: string | null): string | null {
	const base =
		kind === "mark_seen" ? "Marked as seen" : kind === "dismiss_error" ? "Error dismissed" : null;
	if (base === null) return null;
	return forOwnerName ? `${base} for ${forOwnerName}` : base;
}

export interface AckActionDerivation {
	/** null when no action applies — see permissionWaitNote/notOwnerNote for why. */
	kind: AckActionKind | null;
	/**
	 * Set when `kind` is null because an outstanding permission prompt
	 * overrides the acknowledge-ability of a WAITING session (see
	 * hasOutstandingPermissionWait in shared/session-state.ts) — acknowledging
	 * can never clear WAITING while this is true, so no button is offered at
	 * all, only this explanatory note.
	 */
	permissionWaitNote: string | null;
	/** Set when `kind` is null because the viewer isn't the session's owner. */
	notOwnerNote: string | null;
}

export const PERMISSION_WAIT_NOTE = "Permission prompt open — answer it in the terminal";
const NOT_OWNER_NOTE_SEEN = "Only the owner can mark this as seen";
const NOT_OWNER_NOTE_ERROR = "Only the owner can dismiss this error";
/** Team mode: an admin may also act, so the note says so. */
const NOT_OWNER_NOTE_SEEN_TEAM = "Only the owner or an admin can mark this as seen";
const NOT_OWNER_NOTE_ERROR_TEAM = "Only the owner or an admin can dismiss this error";

const NO_ACTION: AckActionDerivation = { kind: null, permissionWaitNote: null, notOwnerNote: null };

/**
 * One derivation shared by the session card and the detail header (AGEN) —
 * previously each hand-rolled its own version of this logic, and the
 * card's version had no permission-wait or not-owner case at all. Four
 * action kinds, in precedence order:
 *
 *   mark_seen     — WAITING, no outstanding permission wait, viewer owns it
 *   dismiss_error — ERROR, viewer owns it
 *   restore_error — the session's current failure was dismissed
 *                   (status: "failed", classifies "completed"), viewer owns it
 *   mark_unseen   — IDLE with a prior acknowledgement, viewer owns it
 *
 * A WAITING session blocked on an outstanding permission prompt gets
 * `permissionWaitNote` instead of `mark_seen` regardless of ownership —
 * even the owner can't clear WAITING by acknowledging while a prompt is
 * outstanding (hasOutstandingPermissionWait overrides the turn/failure
 * signal in getOperationalStatus), so offering the button at all would be
 * a false promise. A WAITING or ERROR session the viewer doesn't own gets
 * `notOwnerNote` instead of a button.
 */
export function deriveAckAction(
	session: OperationalStatusInput,
	canAcknowledge: boolean,
): AckActionDerivation {
	const status = getOperationalStatus(session);

	if (status === "waiting") {
		if (hasOutstandingPermissionWait(session)) {
			return { kind: null, permissionWaitNote: PERMISSION_WAIT_NOTE, notOwnerNote: null };
		}
		if (!canAcknowledge)
			return { kind: null, permissionWaitNote: null, notOwnerNote: NOT_OWNER_NOTE_SEEN };
		return { kind: "mark_seen", permissionWaitNote: null, notOwnerNote: null };
	}

	if (status === "error") {
		if (!canAcknowledge)
			return { kind: null, permissionWaitNote: null, notOwnerNote: NOT_OWNER_NOTE_ERROR };
		return { kind: "dismiss_error", permissionWaitNote: null, notOwnerNote: null };
	}

	if (!canAcknowledge || session.lastUserAcknowledgedAt == null) return NO_ACTION;

	if (status === "completed" && session.status === "failed") {
		return { kind: "restore_error", permissionWaitNote: null, notOwnerNote: null };
	}
	if (status === "idle") {
		return { kind: "mark_unseen", permissionWaitNote: null, notOwnerNote: null };
	}
	return NO_ACTION;
}

// ── List-refresh hold with a bound (AGEN) ───────────────────────────────────

/**
 * Decides whether a debounced background refresh may run now, given that
 * the grid is (or isn't) currently being interacted with (hovered/focused).
 * While interacting, the refresh is held so rows don't move under the
 * pointer — but the hold is bounded: once `heldMs` reaches `maxHoldMs`, the
 * refresh runs anyway, so a permanently-hovered grid (e.g. a stuck mouse,
 * or a person who never moves the pointer away) can't starve the view of
 * live updates forever.
 */
export function shouldRunHeldRefresh(input: {
	isInteracting: boolean;
	heldMs: number;
	maxHoldMs: number;
}): boolean {
	if (!input.isInteracting) return true;
	return input.heldMs >= input.maxHoldMs;
}

/** How long the grid's pointer/keyboard-interaction hold may run before it's released regardless of continued hover/focus (AGEN) — a resting pointer must not freeze the sort order forever. */
export const MAX_POINTER_HOLD_MS = 3000;

// ── Mark-all paginator ───────────────────────────────────────────────────────

export interface MarkAllPageResult<T> {
	sessions: readonly T[];
	total: number;
}

export interface MarkAllPaginatorOptions {
	pageSize?: number;
	/** Mirrors the server's own operational-candidate cap — a bound generous for any real deployment, not a realistic page count to hit. */
	hardCap?: number;
}

/**
 * Pages through a server-filtered list (the same `operational=waiting`
 * endpoint the status-card grid uses) up to `total` or `hardCap`, whichever
 * comes first — the full set "Mark all as seen" must act on, not just
 * whatever page the dashboard happens to have loaded. `fetchPage` is
 * injected so this stays DOM/store-free and testable with a fake.
 */
export async function collectMarkAllPages<T>(
	fetchPage: (offset: number, limit: number) => Promise<MarkAllPageResult<T>>,
	options: MarkAllPaginatorOptions = {},
): Promise<T[]> {
	const pageSize = options.pageSize ?? 100;
	const hardCap = options.hardCap ?? 5000;
	const collected: T[] = [];
	let offset = 0;
	for (;;) {
		const res = await fetchPage(offset, pageSize);
		collected.push(...res.sessions);
		offset += res.sessions.length;
		if (res.sessions.length === 0 || offset >= res.total || offset >= hardCap) break;
	}
	return collected;
}

/** One line describing progress mid-run, e.g. "Marking 60 of 182…". */
export function markAllProgressText(done: number, total: number): string {
	return `Marking ${done} of ${total}…`;
}

/**
 * The mark-all button's label, derived from one snapshot of the target
 * set so it can never disagree with itself mid-render: "Mark all N as
 * seen" when every waiting session is the viewer's to mark, otherwise
 * "Mark M of N as seen" with a note about why the rest are excluded.
 */
export function markAllButtonLabel(params: {
	targetCount: number;
	totalWaiting: number;
	skippedNotOwner: number;
	skippedPermissionWait: number;
}): string {
	const { targetCount, totalWaiting, skippedNotOwner, skippedPermissionWait } = params;
	if (targetCount === totalWaiting && targetCount > 0) {
		return `Mark all ${totalWaiting} as seen`;
	}
	const reasons: string[] = [];
	if (skippedNotOwner > 0) reasons.push("belong to others");
	if (skippedPermissionWait > 0) reasons.push("have an open permission prompt");
	const note = reasons.length > 0 ? ` (the rest ${reasons.join(" or ")})` : "";
	return `Mark ${targetCount} of ${totalWaiting} as seen${note}`;
}

/** One line describing an in-flight bulk Undo, e.g. "Restoring 60 of 182…" — the Undo-side counterpart of markAllProgressText, so "mark all" and its Undo read the same way mid-run. */
export function restoreAllProgressText(done: number, total: number): string {
	return `Restoring ${done} of ${total}…`;
}

// ── Dismiss notification: banner vs toast (AGEN) ────────────────────────────

/**
 * Whether acknowledging a session must also raise a toast (with its own
 * Undo action) rather than relying solely on the card's inline banner.
 * "Mark as seen" is safe with the banner alone: the card stays mounted
 * (WAITING -> IDLE keeps it in the active grid). "Dismiss error" is not:
 * the card can unmount the instant the dismissal lands — on the unfiltered
 * dashboard the session drops out of the active grid as soon as its
 * operational status flips to "completed", before the banner's timer ever
 * gets seen. A toast lives in its own render tree (outside the card), so
 * it survives that unmount; the inline banner also still renders when the
 * card happens to stay mounted (e.g. the filtered Error view's held list),
 * which is harmless duplication, not a conflict.
 */
export function shouldRaiseDismissToast(variant: "seen" | "dismissed"): boolean {
	return variant === "dismissed";
}

// ── Unfiltered-tab caption (AGEN) ────────────────────────────────────────────

/**
 * "Showing N of M" caption for an unfiltered tab (All, or Active with no
 * status card selected) — null when there's nothing to say (total unknown,
 * or every loaded row is already shown). While a text search is active,
 * `totalCount` (the tab's pre-search badge count) is no longer a meaningful
 * denominator — it would imply more matches are hidden than actually exist
 * — so the caption reports the search's own match count instead of
 * comparing it against the pre-search total.
 */
export function unfilteredTabCaption(params: {
	shownCount: number;
	totalCount: number | undefined;
	searchActive: boolean;
}): string | null {
	if (params.searchActive) {
		return `Showing ${params.shownCount} matching`;
	}
	if (params.totalCount === undefined || params.shownCount >= params.totalCount) return null;
	return `Showing ${params.shownCount} of ${params.totalCount}`;
}

// ── Search debounce (AGEN) ───────────────────────────────────────────────────

/** How long the dashboard search box waits after the last keystroke before it re-queries the server — keeps a fast typist from firing one request per character. */
export const SEARCH_DEBOUNCE_MS = 250;

// ── Second user: "Connect your machine" ─────────────────────────────────────

/**
 * In team mode, someone with no key of their own and no session of their own
 * gets a compact prompt above the tiles. Not before the key list has loaded
 * (no flash for someone who has keys), and never again once dismissed.
 */
export function shouldShowConnectCard(input: {
	showTeamCopy: boolean;
	keysLoaded: boolean;
	ownActiveKeys: number;
	ownSessions: number;
	dismissed: boolean;
}): boolean {
	return (
		input.showTeamCopy &&
		input.keysLoaded &&
		input.ownActiveKeys === 0 &&
		input.ownSessions === 0 &&
		!input.dismissed
	);
}

/** localStorage key for "Not now", per person so a shared browser doesn't hide it for the next one. */
export function connectCardDismissKey(userId: string | null): string {
	return `agentpulse.connectCardDismissed.${userId ?? "anonymous"}`;
}

export type AckActionForViewer = AckActionDerivation & { forOwnerName: string | null };

/**
 * The derivation for a viewer who may be an admin acting on someone else's
 * session. Only the two explicit single-session buttons (mark as seen,
 * dismiss error) accept that override; restoring and marking unseen stay with
 * the owner.
 */
export function deriveAckActionForViewer(
	session: OperationalStatusInput,
	access: { isOwnerOrUnowned: boolean; adminForOwnerName: string | null; teamMode: boolean },
): AckActionForViewer {
	if (access.isOwnerOrUnowned) return { ...deriveAckAction(session, true), forOwnerName: null };
	const plain = deriveAckAction(session, false);
	const refused = access.teamMode
		? {
				...plain,
				notOwnerNote:
					plain.notOwnerNote === NOT_OWNER_NOTE_SEEN
						? NOT_OWNER_NOTE_SEEN_TEAM
						: plain.notOwnerNote === NOT_OWNER_NOTE_ERROR
							? NOT_OWNER_NOTE_ERROR_TEAM
							: plain.notOwnerNote,
			}
		: plain;
	if (access.adminForOwnerName === null) return { ...refused, forOwnerName: null };
	// Only a refusal for a missing owner is overridden; a permission prompt keeps its note.
	if (plain.notOwnerNote === null) return { ...refused, forOwnerName: null };
	return { ...deriveAckAction(session, true), forOwnerName: access.adminForOwnerName };
}

// ── Search over the whole scope ──────────────────────────────────────────────

/**
 * The rows a text search shows: everything the server matched anywhere in the
 * scope, plus any loaded row the in-page filter matches (it also looks at the
 * current task, which the server's search doesn't), without repeats. Server
 * rows first, so older matches aren't lost behind the newest page.
 */
export function mergeSearchRows<T extends { sessionId: string }>(
	serverRows: readonly T[] | null,
	pageRows: readonly T[],
): T[] {
	if (serverRows === null) return [...pageRows];
	const seen = new Set(serverRows.map((row) => row.sessionId));
	return [...serverRows, ...pageRows.filter((row) => !seen.has(row.sessionId))];
}

// ── Status chip ─────────────────────────────────────────────────────────────

/**
 * The chip beside a selected status card. Without a search it is the label and
 * the list's own count (the card's count until the list answers). With one it
 * says what matched out of what the card counts: Waiting matching "billing": 21 of 68.
 */
export function statusChipText(input: {
	label: string;
	listTotal: number | null;
	cardCount: number;
	search: string;
}): string {
	const term = input.search.trim();
	if (term)
		return `${input.label} matching "${term}": ${input.listTotal ?? 0} of ${input.cardCount}`;
	return `Showing: ${input.label} (${input.listTotal ?? input.cardCount})`;
}

// ── What a card offers ──────────────────────────────────────────────────────

/**
 * The acknowledge action on a session CARD: only what the viewer can do. A
 * session that is someone else's gets no button and no explanation (its status
 * badge and owner chip say whose turn it is); the admin's override lives on the
 * detail page. An unowned session is anyone's, so it keeps the plain action.
 */
export function deriveCardAckAction(
	session: OperationalStatusInput,
	canAcknowledge: boolean,
): AckActionDerivation {
	if (!canAcknowledge) return NO_ACTION;
	return deriveAckAction(session, true);
}
