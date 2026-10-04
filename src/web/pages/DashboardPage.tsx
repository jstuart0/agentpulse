import { ChevronDown, HelpCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
	ACTIVE_OPERATIONAL_STATUSES,
	type ActiveOperationalStatus,
	compareOperational,
	countOperationalStatuses,
	getOperationalStatus,
	hasOutstandingPermissionWait,
	isActiveOperationalSession,
	isVisibleSession,
} from "../../shared/session-state.js";
import type { Session } from "../../shared/types.js";
import { ConnectMachineCard } from "../components/ConnectMachineCard.js";
import { DashboardViewControls, ScratchToggle } from "../components/DashboardViewControls.js";
import { FirstRunWelcome } from "../components/FirstRunWelcome.js";
import { OwnerSelect } from "../components/OwnerSelect.js";
import { ScopeSwitch } from "../components/ScopeSwitch.js";
import { SessionGrid } from "../components/SessionGrid.js";
import { StatCard } from "../components/StatCard.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useAllWaitingSessions } from "../hooks/useAllWaitingSessions.js";
import { useDefaultOwnerScope } from "../hooks/useDefaultOwnerScope.js";
import { useHostScope } from "../hooks/useHostScope.js";
import { useListFollowsCount } from "../hooks/useListFollowsCount.js";
import { useMachineStats } from "../hooks/useMachineStats.js";
import { useNoteUnknownOwners } from "../hooks/useNoteUnknownOwners.js";
import { useOperationalSessionList } from "../hooks/useOperationalSessionList.js";
import { useOwnerGroupStats } from "../hooks/useOwnerGroupStats.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { useSessions } from "../hooks/useSessions.js";
import { type ListedTab, useTabSessionList } from "../hooks/useTabSessionList.js";
import { ApiError, api } from "../lib/api.js";
import { HOST_ALL } from "../lib/host-scope.js";
import { browserStorage } from "../lib/id-set-storage.js";
import { ownerChipVisible } from "../lib/owner-chip.js";
import { ownerLabel } from "../lib/owner-label.js";
import { type DashboardScope, OWNER_ALL, OWNER_ME, personOwnerId } from "../lib/owner-scope.js";
import { canAcknowledgeSession, cn, formatDuration } from "../lib/utils.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { useUsersStore } from "../stores/users-store.js";
import {
	displayCount,
	expectedListTotal,
	liveStripText,
	tabBadgeCount,
	tabHint,
} from "./dashboard-counts.js";
import {
	dashboardEmptyState,
	shouldShowFirstRun,
	tabListCaption,
	tabViewState,
} from "./dashboard-empty.js";
import {
	type GroupBy,
	groupByStorageKey,
	hostStatsByKey,
	machineKeysWithSessions,
	parseGroupBy,
} from "./dashboard-groups.js";
import {
	MACHINE_DROPPED_NOTE,
	MACHINE_REFUSED_NOTE,
	groupByOptions,
	hasUnlistedMachine,
	machineAnnouncement,
	machineControlVisible,
	machineEmptyState,
	machineLabel,
	machineOptions,
	machineScopeText,
	teamLineText,
	viewControlsVisible,
	waitingOnOtherMachines,
} from "./dashboard-machines.js";
import {
	type ViewKind,
	nextRefreshDelay,
	othersActiveCount,
	ownerFromSelectValue,
	pollRefreshesLists,
	scopeAnnouncement,
	stateHelp,
	tileTitles,
	viewKind,
} from "./dashboard-scope.js";
import {
	type AckAttemptOutcome,
	SEARCH_DEBOUNCE_MS,
	UNDO_WINDOW_MS,
	chunk,
	classifyAckResponse,
	deriveListView,
	markAllButtonLabel,
	markAllProgressText,
	mergeSearchRows,
	restoreAllProgressText,
	selectMarkAllTargets,
	statusChipText,
	summarizeMarkAll,
} from "./dashboard-view-state.js";

// AGEN: bulk "mark all as seen" sends one request per session, capped at
// this many in flight at once rather than firing the whole waiting set
// simultaneously. Shared by the mark-all run itself and its batched Undo.
const MARK_ALL_CONCURRENCY = 5;

/** A "Retry" that ends a sentence stays on the sentence's line: padding on an inline element grows the tap area without growing the line. */
const INLINE_RETRY =
	"inline whitespace-nowrap py-3 font-medium underline md:py-0 [@media(pointer:coarse)]:py-3";

// AGEN: a 429 from the per-session rate limiter (hook-rate-limit.ts) gets
// one retry after a short wait rather than counting as a hard failure —
// the token bucket replenishes roughly once a second.
const RATE_LIMIT_RETRY_DELAY_MS = 1100;
const RATE_LIMIT_MAX_ATTEMPTS = 3;

// How long after a WS session_updated/session_created message (or the
// unfiltered 30s poll) before the stats tile and the selected status
// card's server-paged list are allowed to refetch. Debounced so a burst of
// hook events doesn't fire a stats/list request per event.
const LIVE_REFRESH_DEBOUNCE_MS = 500;
/** A steady stream of updates can't postpone the stats refresh past this. */
const LIVE_REFRESH_MAX_WAIT_MS = 5000;

export function DashboardPage() {
	const navigate = useNavigate();
	const ui = useOwnershipUi();
	const showScratch = useUiPrefsStore((s) => s.showScratch);
	const setShowScratch = useUiPrefsStore((s) => s.setShowScratch);

	// ONE description of what the page shows: whose sessions, and whether scratch
	// workspaces are in. Every request below is built from it with scopedQuery().
	const { owner, resolved: ownerResolved, choose: chooseOwner } = useDefaultOwnerScope();
	const { host, resolved: hostResolved, choose: chooseHost, storedChoiceDropped } = useHostScope();
	const scopeResolved = ownerResolved && hostResolved;
	const scope = useMemo<DashboardScope | null>(
		() => (scopeResolved ? { owner, excludeScratch: !showScratch, host } : null),
		[scopeResolved, owner, showScratch, host],
	);
	const scopeForLists = scope ?? { owner: OWNER_ALL, excludeScratch: !showScratch, host };
	const viewKindNow: ViewKind = viewKind(ui.showScope, owner);
	// Phone-width compaction (four cards in a row, a collapsed Live Sessions panel, a
	// short mark-all label) is for team mode; solo keeps its layout exactly.
	const teamLayout = ui.showScope;
	const viewerUserId = useUserStore((s) => s.userId);
	const directory = useUsersStore((s) => s.byId);
	const [groupBy, setGroupByState] = useState<GroupBy>(() =>
		parseGroupBy(browserStorage()?.getItem(groupByStorageKey(viewerUserId)) ?? null),
	);
	function setGroupBy(next: GroupBy) {
		setGroupByState(next);
		try {
			browserStorage()?.setItem(groupByStorageKey(viewerUserId), next);
		} catch {
			// Storage refused the write: the choice still holds for this visit.
		}
	}
	const ownerGroupStats = useOwnerGroupStats(scope, ui.showGroupBy && groupBy === "user");
	// The machines the filter offers and the Group by Machine headers' counts: one
	// request for both, always about every machine in the owner scope on screen.
	const machineStats = useMachineStats(scope);
	const machineControl = machineControlVisible({
		machineCount: machineStats.machineCount,
		host,
		groupBy,
	});
	// A "user" grouping stored in a team has nothing to group by in solo.
	const groupByNow: GroupBy = !ui.showGroupBy && groupBy === "user" ? "project" : groupBy;
	const machineSelectRef = useRef<HTMLSelectElement>(null);
	const [machineNote, setMachineNote] = useState("");
	const chooseMachine = useCallback(
		(next: string) => {
			if (chooseHost(next)) setMachineNote(machineAnnouncement(next));
			else setMachineNote(MACHINE_REFUSED_NOTE);
		},
		[chooseHost],
	);
	// A saved machine the filter can't express was dropped at load: say so.
	useEffect(() => {
		if (storedChoiceDropped) setMachineNote(MACHINE_DROPPED_NOTE);
	}, [storedChoiceDropped]);
	// Group-by "machine" counts come from the same answer as the filter's options.
	const machineCountsByKey = useMemo(
		() => (machineStats.groups ? hostStatsByKey(machineStats.groups) : null),
		[machineStats.groups],
	);
	useNoteUnknownOwners([personOwnerId(owner)]);

	const [filter, setFilter] = useState<string>("active");
	// Single-select operational status filter, driven by the four status cards.
	// Only meaningful on the Active tab; selecting a card switches to it.
	const [statusFilter, setStatusFilter] = useState<ActiveOperationalStatus | null>(null);
	const [search, setSearch] = useState("");
	// AGEN: the server-bound search (useOperationalSessionList's `q`) is
	// debounced so a fast typist doesn't fire one request per keystroke —
	// the client-side filter over already-loaded rows below still reacts to
	// every keystroke immediately, since that's a pure in-memory filter
	// with no request behind it.
	const [debouncedSearch, setDebouncedSearch] = useState("");
	useEffect(() => {
		const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [search]);
	const [selectedActiveSessionId, setSelectedActiveSessionId] = useState<string | null>(null);
	const [helpOpen, setHelpOpen] = useState(false);
	const [moreStatsOpen, setMoreStatsOpen] = useState(false);
	// Phones start on the list: the Live Sessions panel is one summary line until opened.
	const [liveOpen, setLiveOpen] = useState(false);

	// Holds the grid's background refresh while a card is being interacted
	// with (hovered or focused), so rows never move under the pointer —
	// the refresh retries shortly after pointer-leave/blur instead.
	const gridInteractingRef = useRef(false);
	const gridRef = useRef<HTMLDivElement>(null);
	const ownerSelectRef = useRef<HTMLSelectElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const listHeadingRef = useRef<HTMLHeadingElement>(null);
	/** Where focus goes when the control the person used is about to disappear (Retry, mark all). */
	const focusList = useCallback(() => {
		requestAnimationFrame(() => listHeadingRef.current?.focus());
	}, []);
	const filterChipRef = useRef<HTMLDivElement>(null);
	const isGridInteracting = useCallback(() => gridInteractingRef.current, []);

	// Server-paged list for the selected status card: inactive when none is
	// selected (the unfiltered views use the page useSessions() loaded). The
	// search text is sent along so a match past the first page is still found,
	// and the scope is applied server-side, so the list, its total and the card's
	// count are about the same set.
	const operationalList = useOperationalSessionList(
		statusFilter,
		isGridInteracting,
		debouncedSearch,
		scopeForLists,
	);
	// Every tab (Active with no status card selected, Completed, Archived, All) lists the
	// whole scope from the server, so a tab is never empty while its badge is not.
	const listedTab: ListedTab | null =
		filter === "active" && statusFilter ? null : (filter as ListedTab);
	const tabList = useTabSessionList(listedTab, isGridInteracting, debouncedSearch, scopeForLists);

	// The poll asks everything at one moment; what else depends on that moment
	// (the per-owner headers, a selected status list) is refreshed with it.
	const {
		sessions,
		stats,
		isLoading: listLoading,
		totalSessions,
		othersStats,
		scopeMismatch,
		loadError,
		refreshDelayed,
		retry: retryScope,
		refreshCounts,
	} = useSessions(scope, (reason) => {
		if (ui.showGroupBy && groupBy === "user") void ownerGroupStats.refresh();
		void machineStats.refresh();
		if (reason === "retry") {
			// A refused or failed list is asked again with the counts, then focus returns to the header.
			operationalList.reload();
			tabList.reload();
			requestAnimationFrame(() => headingRef.current?.focus());
		} else if (
			reason === "reconnect" ||
			pollRefreshesLists(useConnectionStore.getState().wsState)
		) {
			operationalList.scheduleRefresh();
			tabList.scheduleRefresh();
		}
	});
	const isLoading = !scopeResolved || listLoading;

	// The server applies the scope and the scratch toggle before paging, so the
	// page it sent is already the view; nothing here re-filters it.
	const visibleSessions = sessions;
	const searchTerm = search.trim();

	// The active operational set: not ended, not completed, not archived. Every
	// operational surface on this page (status cards, counts, filter, live
	// strip) is computed from this one list with the shared classifier, so
	// they can never disagree. Lifecycle `idle` rows (inactivity sweep) are
	// still active here — they classify as WAITING / IDLE, same as any other
	// active row.
	const operationalSessions = useMemo(
		() => visibleSessions.filter(isActiveOperationalSession),
		[visibleSessions],
	);
	// AGEN: the server's own counts (GET /sessions/stats) are authoritative
	// beyond the single page useSessions fetches — fall back to the
	// client-computed count only until stats has loaded once. The client
	// fallback classifies rather than counting the (unfiltered) candidate
	// set, so an acknowledged failure never inflates it.
	const clientCounts = useMemo(
		() => countOperationalStatuses(operationalSessions),
		[operationalSessions],
	);
	const counts = stats?.operational ?? clientCounts;
	// AGEN: one definition of "active" everywhere on the dashboard — the sum
	// of the four operational counts. Used for the Active Sessions tile, the
	// Active tab badge, and the Live strip's "N active" (see each usage
	// below); never a separate lifecycle-status count.
	const activeTotal = counts.waiting + counts.working + counts.idle + counts.error;
	const scopeTotal = stats?.total ?? totalSessions;
	// Whatever paged list is on screen follows the counts that describe it: a poll or a
	// refresh whose count differs from the list's total reloads that list.
	const countedList =
		filter === "active" && statusFilter ? operationalList : listedTab ? tabList : null;
	useListFollowsCount({
		listTotal: countedList?.total ?? null,
		settled: countedList !== null && !countedList.loading,
		expected: expectedListTotal({
			tab: filter,
			status: statusFilter,
			stats,
			searching: searchTerm.length > 0,
		}),
		countsVersion: stats,
		refresh: () => countedList?.scheduleRefresh(),
	});
	const searchActive = search.trim().length > 0;

	// A live change (a socket message, an action on a card) re-asks the counts
	// after a quiet moment, together: the scoped stats, the everyone stats under
	// Mine and the per-owner headers, so the numbers beside each other always
	// come from one moment. The poll refreshes all of that itself.
	const liveChanges = useSessionStore((s) => s.liveChanges);
	const seenLiveChangesRef = useRef(liveChanges);
	const firstPendingRef = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new live change schedules a refresh
	useEffect(() => {
		if (liveChanges === seenLiveChangesRef.current) return;
		seenLiveChangesRef.current = liveChanges;
		if (!scope || isLoading) return;
		const now = Date.now();
		if (firstPendingRef.current === null) firstPendingRef.current = now;
		const delay = nextRefreshDelay({
			now,
			firstPendingAt: firstPendingRef.current,
			debounceMs: LIVE_REFRESH_DEBOUNCE_MS,
			maxWaitMs: LIVE_REFRESH_MAX_WAIT_MS,
		});
		const t = setTimeout(() => {
			firstPendingRef.current = null;
			void refreshCounts();
			if (ui.showGroupBy && groupBy === "user") void ownerGroupStats.refresh();
			// A pushed session on a machine the control doesn't list yet brings the control (or
			// its new option) in now, not at the next poll.
			if (
				machineControl ||
				groupBy === "machine" ||
				hasUnlistedMachine(useSessionStore.getState().sessions, machineStats.groups)
			) {
				void machineStats.refresh();
			}
		}, delay);
		operationalList.scheduleRefresh();
		tabList.scheduleRefresh();
		return () => clearTimeout(t);
	}, [liveChanges]);

	const disableAuth = useUserStore((s) => s.disableAuth);
	const updateSession = useSessionStore((s) => s.updateSession);
	const [markingAll, setMarkingAll] = useState(false);

	// "Mark all as seen" must cover the FULL waiting set, not just whatever
	// page useSessions() happens to have loaded (capped at 100) — a
	// deployment with 150+ sessions would otherwise silently skip waiting
	// sessions past the first page. Paged through the server's own
	// operational=waiting filter (same endpoint the status-card grid
	// uses), debounced on the same signal as the stats/list refresh so a
	// burst of live updates doesn't re-run the full scan per event.
	const allWaitingSessions = useAllWaitingSessions(scope, counts.waiting);

	const {
		targets: markableTargets,
		skippedNotOwner: markAllPreSkipped,
		skippedPermissionWait: markAllPreSkippedPermissionWait,
	} = useMemo(
		() =>
			selectMarkAllTargets(
				allWaitingSessions,
				(s) => canAcknowledgeSession(s, viewerUserId, disableAuth),
				(s) => hasOutstandingPermissionWait(s),
			),
		[allWaitingSessions, viewerUserId, disableAuth],
	);
	// AGEN: one snapshot drives the button label, "N of M" wording, and the
	// eventual summary — they can never read as three different counts.
	const markAllLabel = markAllButtonLabel({
		targetCount: markableTargets.length,
		totalWaiting: counts.waiting,
		skippedNotOwner: markAllPreSkipped,
		skippedPermissionWait: markAllPreSkippedPermissionWait,
	});
	const [markAllProgress, setMarkAllProgress] = useState<{ done: number; total: number } | null>(
		null,
	);
	// AGEN: disables the mark-all button (and prevents a second concurrent
	// run) for the duration of the bulk Undo, not just the original mark —
	// the toast's own Undo action has no button of its own to disable, so
	// this is surfaced as a progress string replacing the toast's success
	// message instead (restoreAllProgressText).
	const [undoingAll, setUndoingAll] = useState(false);

	/** A 429 gets up to RATE_LIMIT_MAX_ATTEMPTS-1 retries, waiting between each. */
	async function acknowledgeWithRetry(sessionId: string): Promise<AckAttemptOutcome> {
		for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
			try {
				const result = await api.acknowledgeSession(sessionId);
				return classifyAckResponse(result);
			} catch (err) {
				const isRateLimited = err instanceof ApiError && err.status === 429;
				if (!isRateLimited || attempt === RATE_LIMIT_MAX_ATTEMPTS) return "failed";
				await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
			}
		}
		return "failed";
	}

	async function unacknowledgeWithRetry(sessionId: string): Promise<AckAttemptOutcome> {
		for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
			try {
				const result = await api.unacknowledgeSession(sessionId);
				return classifyAckResponse(result);
			} catch (err) {
				const isRateLimited = err instanceof ApiError && err.status === 429;
				if (!isRateLimited || attempt === RATE_LIMIT_MAX_ATTEMPTS) return "failed";
				await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
			}
		}
		return "failed";
	}

	async function handleMarkAllWaitingAsSeen() {
		if (markableTargets.length === 0) return;
		setMarkingAll(true);
		setMarkAllProgress({ done: 0, total: markableTargets.length });
		const applied: typeof markableTargets = [];
		const outcomes: AckAttemptOutcome[] = [];
		try {
			for (const batch of chunk(markableTargets, MARK_ALL_CONCURRENCY)) {
				const results = await Promise.all(
					batch.map((session) => acknowledgeWithRetry(session.sessionId)),
				);
				for (let i = 0; i < batch.length; i++) {
					outcomes.push(results[i]);
					if (results[i] === "applied") {
						const now = new Date().toISOString();
						updateSession({ ...batch[i], lastUserAcknowledgedAt: now });
						applied.push(batch[i]);
					}
				}
				setMarkAllProgress({ done: outcomes.length, total: markableTargets.length });
			}
		} finally {
			setMarkingAll(false);
			setMarkAllProgress(null);
			// The button may be gone now that nothing is left to mark: focus stays on the list.
			focusList();
		}
		const summary = summarizeMarkAll({
			totalWaiting: counts.waiting,
			preSkippedNotOwner: markAllPreSkipped,
			preSkippedPermissionWait: markAllPreSkippedPermissionWait,
			outcomes,
		});
		const appliedSnapshot = applied;
		const skippedNote =
			summary.skippedNotOwner > 0 && summary.skippedPermissionWait > 0
				? ` · ${summary.skippedNotOwner + summary.skippedPermissionWait} skipped (not yours or awaiting a permission prompt)`
				: summary.skippedNotOwner > 0
					? ` · ${summary.skippedNotOwner} skipped (not yours)`
					: summary.skippedPermissionWait > 0
						? ` · ${summary.skippedPermissionWait} skipped (awaiting a permission prompt)`
						: "";
		toast.success(
			summary.failed > 0
				? `Marked ${summary.done} of ${summary.totalWaiting} as seen (${summary.failed} failed)`
				: `Marked ${summary.done} as seen${skippedNote}`,
			{
				action:
					appliedSnapshot.length > 0
						? {
								label: "Undo",
								onClick: () => {
									// AGEN: ignore a second click while an undo is already
									// running -- there's no button here to disable, so the
									// in-flight guard does the same job.
									if (undoingAll) return;
									setUndoingAll(true);
									const toastId = toast.loading(restoreAllProgressText(0, appliedSnapshot.length));
									void (async () => {
										const undoFailures: Session[] = [];
										let done = 0;
										try {
											for (const batch of chunk(appliedSnapshot, MARK_ALL_CONCURRENCY)) {
												await Promise.all(
													batch.map(async (session) => {
														const outcome = await unacknowledgeWithRetry(session.sessionId);
														if (outcome === "applied") {
															updateSession({ ...session, lastUserAcknowledgedAt: null });
														} else {
															undoFailures.push(session);
														}
													}),
												);
												done += batch.length;
												toast.loading(restoreAllProgressText(done, appliedSnapshot.length), {
													id: toastId,
												});
											}
											if (undoFailures.length > 0) {
												toast.error(
													`Couldn't undo ${undoFailures.length} of ${appliedSnapshot.length}`,
													{ id: toastId },
												);
											} else {
												toast.success(`Restored ${appliedSnapshot.length} to waiting`, {
													id: toastId,
												});
											}
										} finally {
											setUndoingAll(false);
										}
									})();
								},
							}
						: undefined,
				duration: UNDO_WINDOW_MS,
			},
		);
	}

	// Filter by tab, then by operational status.
	// 'archived' tab is a UI tab id mapped to isArchived=true — not a SessionStatus value.
	// Slice G: isArchived is the canonical archive truth; status='archived' is legacy.
	// 'active' tab is the operational set, narrowed by the selected status card.
	// AGEN: operationalList.rows is now scratch-excluded server-side
	// (excludeScratch, passed into useOperationalSessionList above) when
	// the toggle is off, so this no longer needs its own client-side
	// re-filter to agree with the toggle.
	// Every tab's rows, and a selected status card's rows, come from the server with the
	// search (`q`) already applied over the whole scope, not only the page loaded.
	// The All tab also keeps the in-page match on a session's current task, which the
	// server's search doesn't look at: loaded rows that match are added after the server's.
	const pageMatches = useMemo(() => {
		if (filter !== "all" || !searchTerm) return [];
		const q = searchTerm.toLowerCase();
		return visibleSessions.filter(
			(s) =>
				isVisibleSession(s) &&
				[s.displayName, s.cwd, s.currentTask, s.gitBranch].some((field) =>
					(field || "").toLowerCase().includes(q),
				),
		);
	}, [filter, searchTerm, visibleSessions]);
	const filtered = listedTab
		? filter === "all" && searchTerm
			? mergeSearchRows(tabList.rows, pageMatches)
			: tabList.rows
		: operationalList.rows;

	// The last session of a chosen machine leaving the view is said, not just shown.
	const hadMachineRowsRef = useRef(false);
	useEffect(() => {
		const settled = !isLoading && (listedTab ? !tabList.loading : true);
		if (host === HOST_ALL || !settled) {
			hadMachineRowsRef.current = false;
			return;
		}
		if (filtered.length > 0) hadMachineRowsRef.current = true;
		else if (hadMachineRowsRef.current) {
			hadMachineRowsRef.current = false;
			setMachineNote(`No sessions left on ${machineLabel(host)} in this view.`);
		}
	}, [filtered.length, host, isLoading, listedTab, tabList.loading]);

	// Live strip: the active operational set, ordered so the ones that need a
	// human (waiting, error) come first, then working, then idle.
	// The strip follows the Active tab's full list when it has loaded, else the newest page.
	const stripSource =
		filter === "active" && !statusFilter && tabList.rows.length > 0
			? tabList.rows
			: operationalSessions;
	const activeSessions = useMemo(() => [...stripSource].sort(compareOperational), [stripSource]);
	const workingCount = counts.working;
	const needsAttentionCount = counts.waiting + counts.error;
	const strip = liveStripText({
		ready: stats !== null,
		shown: activeSessions.length,
		activeTotal,
		working: workingCount,
		attention: needsAttentionCount,
	});

	function toggleStatusFilter(status: ActiveOperationalStatus) {
		setFilter("active");
		setStatusFilter((current) => (current === status ? null : status));
		// Narrow screens: bring the list into view so selecting a card (which
		// may be above the fold relative to the grid) doesn't leave the
		// person wondering whether anything happened.
		if (typeof window !== "undefined" && window.innerWidth < 768) {
			requestAnimationFrame(() => {
				filterChipRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	}
	function clearStatusFilter() {
		setStatusFilter(null);
	}
	function selectTab(tab: string) {
		setFilter(tab);
		if (tab !== "active") setStatusFilter(null);
	}
	const selectedActiveSession =
		activeSessions.find((session) => session.sessionId === selectedActiveSessionId) ??
		activeSessions[0] ??
		null;

	useEffect(() => {
		if (!activeSessions.length) {
			setSelectedActiveSessionId(null);
			return;
		}
		if (
			!selectedActiveSessionId ||
			!activeSessions.some((session) => session.sessionId === selectedActiveSessionId)
		) {
			setSelectedActiveSessionId(activeSessions[0].sessionId);
		}
	}, [activeSessions, selectedActiveSessionId]);

	// One polite live region says what the view became when the owner changes.
	const [announcement, setAnnouncement] = useState("");
	const announcedOwnerRef = useRef<string | null>(null);
	const ownerName = personOwnerId(owner)
		? ownerLabel(directory[owner], owner, { selfId: viewerUserId })
		: null;
	useEffect(() => {
		if (!scopeResolved || !ui.showScope) return;
		if (announcedOwnerRef.current === null) {
			announcedOwnerRef.current = owner;
			return;
		}
		if (announcedOwnerRef.current === owner) return;
		announcedOwnerRef.current = owner;
		setAnnouncement(scopeAnnouncement(owner, ownerName));
	}, [owner, ownerName, scopeResolved, ui.showScope]);

	// A fresh install has zero sessions *and* has finished its first fetch
	// (sessions.length === 0 && !isLoading). In that case, skip the KPI/filter
	// chrome entirely and show the Getting-Started card — it collapses the
	// three first-run tasks (mint API key, install hook, start agent) into
	// one screen so new users don't have to hunt through Setup / Settings.
	const showFirstRun = shouldShowFirstRun({
		isLoading,
		loadedCount: sessions.length,
		owner,
		host,
		failed: loadError !== null,
		stats,
	});

	if (showFirstRun) {
		return (
			<div className="p-3 md:p-6 max-w-3xl">
				<div className="mb-4">
					<h1 className="text-xl md:text-2xl font-bold text-foreground">Dashboard</h1>
					<p className="text-sm text-muted-foreground mt-0.5">
						No sessions yet — follow the steps below to wire up your first agent.
					</p>
				</div>
				<FirstRunWelcome serverUrl={window.location.origin} />
			</div>
		);
	}

	// Server-driven paging only applies while a status is selected; otherwise
	// behavior is unchanged (the full filtered client list, no "load more").
	const listView = statusFilter
		? deriveListView({
				loadedRows: operationalList.rows,
				total: operationalList.total,
				truncated: Boolean(stats?.truncated),
			})
		: null;
	const gridIsLoading = listedTab
		? tabList.loading
		: statusFilter && filter === "active"
			? operationalList.loading
			: isLoading;

	// Team views only. Others' active sessions are the unscoped count minus this view's.
	const othersActive = owner === OWNER_ME ? othersActiveCount(othersStats, activeTotal) : 0;
	const tabBadge = tabBadgeCount(filter, stats, filter === "active" ? statusFilter : null);
	const machineEmpty = machineEmptyState({
		host,
		tab: filter,
		statusFilter: filter === "active" ? statusFilter : null,
		searchActive: searchTerm.length > 0,
		scopeTotal,
		tabCount: tabBadge,
		ownerNarrowed: owner !== OWNER_ALL,
	});
	const emptyState = ui.showScope
		? dashboardEmptyState({
				kind: viewKindNow,
				owner,
				ownerName,
				tab: filter,
				statusFilter,
				searchActive: searchTerm.length > 0,
				ownerTotal: scopeTotal,
				othersActive,
				tabCount: tabBadge,
			})
		: null;
	const listFailed = Boolean(
		(filter === "active" && statusFilter && operationalList.error) || (listedTab && tabList.error),
	);
	const tabState =
		listedTab && !tabList.error
			? tabViewState({
					loaded: tabList.rows.length,
					settled: !tabList.loading,
					canLoadMore: tabList.canLoadMore,
					badge: tabBadge,
					searchActive,
				})
			: null;
	const titles = tileTitles(viewKindNow);
	const listHeadingText = `${statusFilter && filter === "active" ? STATUS_CARD_LABEL[statusFilter] : filter.charAt(0).toUpperCase() + filter.slice(1)} sessions`;
	const viewEveryone = () => chooseOwner(OWNER_ALL);
	// "Show all of <name>" narrows to that person; focus follows to the Owner select, where the change is.
	const showAllOf = (ownerId: string) => {
		chooseOwner(ownerFromSelectValue(ownerId, viewerUserId));
		requestAnimationFrame(() => ownerSelectRef.current?.focus());
	};
	// "Show all" over a machine's group narrows to that machine; focus follows to the Machine select, where the change is.
	const showAllOfHost = (machine: string) => {
		chooseMachine(machine);
		requestAnimationFrame(() => machineSelectRef.current?.focus());
	};
	const viewAllMachines = () => {
		chooseMachine(HOST_ALL);
		focusList();
	};

	return (
		<div className="p-3 md:p-6">
			{/* Header. Under Mine | Everyone the subtitle says what the switch does, and the
			    Owner select sits beside it: they are one control (whose sessions). */}
			<div
				className={
					ui.showScope
						? "flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4 md:mb-6"
						: "flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4 md:mb-6"
				}
			>
				<div>
					<h1
						ref={headingRef}
						tabIndex={-1}
						className="text-xl md:text-2xl font-bold text-foreground focus:outline-none"
					>
						Dashboard
					</h1>
					<p
						className={cn(
							"text-sm mt-0.5 max-w-xl",
							ui.showScope ? "text-hint" : "text-muted-foreground",
						)}
					>
						{ui.showScope
							? "Mine is a filter. Everyone who can sign in sees every session."
							: "Your AI coding agents, all in one place"}
					</p>
				</div>
				{ui.showScope && (
					<div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center md:gap-3">
						<ScopeSwitch owner={scopeResolved ? owner : null} onChoose={chooseOwner} />
						{ui.showOwnerSelect && (
							<OwnerSelect
								owner={scopeResolved ? owner : null}
								onChange={chooseOwner}
								people={Object.values(directory)}
								viewerUserId={viewerUserId}
								selectRef={ownerSelectRef}
							/>
						)}
					</div>
				)}
			</div>

			{ui.showScope && (
				<div aria-live="polite" className="sr-only">
					{announcement}
				</div>
			)}
			<div aria-live="polite" className="sr-only">
				{machineNote}
			</div>

			{scopeMismatch ? (
				<div
					role="alert"
					className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-400"
				>
					The server answered for a different set of sessions than the one asked for, so nothing
					from that answer is shown. Choose another view above, or{" "}
					<button type="button" onClick={retryScope} className={INLINE_RETRY}>
						Retry
					</button>
					.
				</div>
			) : loadError ? (
				<div
					role="alert"
					className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-400"
				>
					Couldn't load the sessions: {loadError}{" "}
					<button type="button" onClick={retryScope} className={INLINE_RETRY}>
						Retry
					</button>
				</div>
			) : (
				<>
					{refreshDelayed && (
						<output className="mb-2 block text-xs text-hint">Updates are delayed. Retrying…</output>
					)}
					<ConnectMachineCard suppress={emptyState?.actions.includes("setup") ?? false} />

					{host !== HOST_ALL && (
						<p className="mb-2 text-xs text-foreground [overflow-wrap:anywhere]" data-machine-scope>
							<span className="font-medium">
								{machineScopeText(
									host,
									waitingOnOtherMachines(machineStats.groups, host),
									machineStats.groupsTruncated,
								)}
							</span>{" "}
							<button
								type="button"
								onClick={viewAllMachines}
								className="min-h-[44px] rounded font-medium text-primary underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
							>
								Show all machines
							</button>
						</p>
					)}

					{/* Operational status cards — the four states every active session is
			    in exactly one of, counted over the full active set. Clicking a card
			    is a single-select filter on the grid below; click again to clear.
			    Phone widths: these come first, before the informational tiles. */}
					<div className="flex items-center justify-between gap-2 mb-2">
						<StatusHelpPopover open={helpOpen} onOpenChange={setHelpOpen} kind={viewKindNow} />
						{/* Team phones: the read-only tiles sit behind this toggle, on the help row, so the cards start sooner. Solo keeps it below the cards, where it always was. */}
						{teamLayout && (
							<button
								type="button"
								onClick={() => setMoreStatsOpen((v) => !v)}
								aria-expanded={moreStatsOpen}
								className="md:hidden min-h-[44px] flex items-center text-xs font-medium text-hint hover:text-foreground"
							>
								{moreStatsOpen ? "Hide stats" : "More stats"}
							</button>
						)}
					</div>
					<div
						className={
							teamLayout
								? "grid grid-cols-4 gap-2 md:grid-cols-2 md:gap-4 xl:grid-cols-4 mb-2"
								: "grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4 mb-2"
						}
					>
						{ACTIVE_OPERATIONAL_STATUSES.map((status) => (
							<StatCard
								compact={teamLayout}
								key={status}
								label={STATUS_CARD_LABEL[status]}
								value={displayCount(stats ? counts[status] : null)}
								title={stateHelp(viewKindNow, status)}
								tone={STATUS_CARD_TONE[status]}
								selected={statusFilter === status}
								onClick={() => toggleStatusFilter(status)}
							/>
						))}
					</div>
					{stats?.truncated && (
						<p className="text-[11px] text-amber-800 dark:text-amber-400 mb-2">
							Counts may be under-reported — the session backlog is larger than this view can fully
							scan.
						</p>
					)}
					{othersActive > 0 && !emptyState?.actions.includes("viewEveryone") && (
						<p className="mb-2 text-xs text-hint">
							{teamLineText(othersActive, host)}{" "}
							<button
								type="button"
								onClick={viewEveryone}
								className="min-h-[44px] rounded font-medium text-primary underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
							>
								View everyone
							</button>
						</p>
					)}

					{markableTargets.length > 0 && (
						<div className="mb-3 md:mb-4">
							<button
								type="button"
								onClick={handleMarkAllWaitingAsSeen}
								disabled={markingAll || undoingAll}
								aria-label={markAllLabel}
								className="min-h-[44px] md:min-h-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{markAllProgress ? (
									markAllProgressText(markAllProgress.done, markAllProgress.total)
								) : teamLayout ? (
									<>
										<span className="md:hidden">{markAllLabel.replace(/ \(.*\)$/, "")}</span>
										<span className="hidden md:inline">{markAllLabel}</span>
									</>
								) : (
									markAllLabel
								)}
							</button>
						</div>
					)}

					{!teamLayout && (
						<button
							type="button"
							onClick={() => setMoreStatsOpen((v) => !v)}
							aria-expanded={moreStatsOpen}
							className="md:hidden mb-2 min-h-[44px] flex items-center text-xs font-medium text-muted-foreground hover:text-foreground"
						>
							{moreStatsOpen ? "Hide stats" : "More stats"}
						</button>
					)}

					{/* Informational KPI row — distinct from the status cards above
			    (those are controls; these are read-only counts). Collapsed
			    behind a toggle on phone widths so the status cards stay the
			    first thing on screen. */}
					<div
						className={cn(
							"grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4 mb-4 md:mb-6",
							moreStatsOpen ? "grid" : "hidden md:grid",
						)}
					>
						<StatCard
							compact={teamLayout}
							label="Active Sessions"
							value={displayCount(stats ? activeTotal : null)}
							title={titles.active}
							sub={
								needsAttentionCount > 0
									? `${needsAttentionCount} waiting or error · ${workingCount} working`
									: workingCount > 0
										? `${workingCount} working now`
										: undefined
							}
						/>
						<StatCard
							compact={teamLayout}
							label="Sessions Today"
							value={displayCount(stats?.totalSessionsToday)}
							title={titles.today}
						/>
						<StatCard
							compact={teamLayout}
							label="Tool Uses Today"
							value={displayCount(stats?.totalToolUsesToday)}
							title={titles.toolUses}
						/>
						<StatCard
							compact={teamLayout}
							label="Total Sessions"
							value={displayCount(stats ? scopeTotal : null)}
							title={titles.total}
						/>
					</div>

					{/* Search + Filter */}
					<div className="flex flex-col gap-3 mb-4">
						<div className="flex gap-1 bg-muted rounded-lg p-1 overflow-x-auto scrollbar-none">
							{/* 'archived' here is a UI tab id, mapped to isArchived=true in the
					    filter logic above — not a SessionStatus value (Slice G).
					    'active' is the operational set; the lifecycle 'idle' tab is gone
					    because IDLE is now an operational state (status card above). */}
							{["active", "completed", "archived", "all"].map((f) => {
								// The server's tab counts, correct beyond whatever page is loaded.
								// Undefined (stats not here yet) hides the badge: a zero would be a claim.
								const count = tabBadgeCount(f, stats, null);
								return (
									<button
										key={f}
										type="button"
										title={tabHint(f) ?? undefined}
										onClick={() => selectTab(f)}
										className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
											filter === f
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										}`}
									>
										{f.charAt(0).toUpperCase() + f.slice(1)}
										{count !== undefined && count > 0 && (
											<span
												className={cn(
													"ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-[1.125rem] rounded-full text-[10px] font-medium px-1 tabular-nums",
													filter === f
														? "bg-primary/10 text-primary"
														: "bg-muted text-muted-foreground",
												)}
											>
												{count}
											</span>
										)}
									</button>
								);
							})}
						</div>

						{tabHint(filter) && <p className="-mt-1 text-xs text-hint">{tabHint(filter)}</p>}

						<div className="flex flex-wrap items-center gap-3">
							<div className="relative w-full min-w-0 md:w-auto md:min-w-[9rem] md:max-w-xs md:flex-1 md:basis-44">
								<svg
									aria-hidden="true"
									className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
									/>
								</svg>
								<input
									type="text"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search sessions..."
									className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
								/>
								{search && (
									<button
										type="button"
										onClick={() => setSearch("")}
										className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									>
										<svg
											className="w-3 h-3"
											aria-hidden="true"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
										<span className="sr-only">Clear search</span>
									</button>
								)}
							</div>
							{viewControlsVisible({
								team: ui.showGroupBy,
								machineControl,
								groupBy,
							}) ? (
								<DashboardViewControls
									groupBy={groupByNow}
									groupOptions={groupByOptions({ team: ui.showGroupBy, machineControl })}
									onGroupByChange={setGroupBy}
									machine={
										machineControl
											? {
													host,
													options: machineOptions(machineStats.groups, host, {
														tab: filter,
														statusFilter: filter === "active" ? statusFilter : null,
														groupsTruncated: machineStats.groupsTruncated,
														otherMachines: machineStats.otherMachines,
													}),
													onChange: chooseMachine,
													selectRef: machineSelectRef,
												}
											: null
									}
									showScratch={showScratch}
									onShowScratchChange={setShowScratch}
									scratchHidden={stats?.scratchHidden ?? 0}
								/>
							) : (
								<ScratchToggle
									showScratch={showScratch}
									onChange={setShowScratch}
									scratchHidden={stats?.scratchHidden ?? 0}
								/>
							)}
						</div>
					</div>

					{activeSessions.length > 0 && (
						<div className="mb-4 rounded-lg border border-border bg-card">
							{teamLayout && (
								<button
									type="button"
									onClick={() => setLiveOpen((open) => !open)}
									aria-expanded={liveOpen}
									className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 text-left text-xs text-foreground md:hidden"
								>
									<span className="truncate">
										<span className="font-semibold">Live Sessions</span> · {strip.count}
										{strip.attention ? ` · ${strip.attention}` : ""}
									</span>
									<ChevronDown
										aria-hidden="true"
										className={cn(
											"h-4 w-4 shrink-0 transition-transform",
											liveOpen && "rotate-180",
										)}
									/>
								</button>
							)}
							<div className={cn("md:block", liveOpen || !teamLayout ? "block" : "hidden")}>
								<div className="border-b border-border px-3 py-2.5 md:px-4">
									<div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
										<div>
											<h2 className="text-sm font-semibold text-foreground">Live Sessions</h2>
											<p className="text-xs text-muted-foreground">
												Quick-switch between active sessions without hunting through the grid.
											</p>
										</div>
										<div className="text-xs text-muted-foreground">
											{/* AGEN: activeSessions is bounded to whatever page
								    useSessions() has loaded (max 100) -- when that's
								    fewer than the server's true active total, say so
								    rather than implying this strip shows everyone. */}
											{strip.count} · {strip.working}
											{strip.attention && (
												<span className="ml-1 font-semibold text-amber-800 dark:text-amber-300">
													· {strip.attention}
												</span>
											)}
										</div>
									</div>
								</div>

								<div className="border-b border-border px-2 py-2 md:px-3">
									<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
										{activeSessions.map((session) => {
											const label = session.displayName || session.sessionId.slice(0, 8);
											const isSelected = session.sessionId === selectedActiveSession?.sessionId;
											const opStatus = getOperationalStatus(session);
											return (
												<button
													key={session.sessionId}
													type="button"
													onClick={() => setSelectedActiveSessionId(session.sessionId)}
													className={`min-w-0 shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
														isSelected
															? "border-primary/30 bg-primary/10 text-primary"
															: "border-border bg-background text-foreground hover:bg-accent"
													}`}
												>
													<div className="flex items-center gap-2">
														<span className="truncate text-sm font-medium">{label}</span>
														{/* Same classifier and badge as the session cards, so the
											    strip never disagrees with the grid (all four states). */}
														<StatusBadge status={opStatus} className="shrink-0" />
													</div>
													<div className="mt-1 truncate text-[11px] text-muted-foreground">
														{session.cwd?.split("/").pop() || "No project"}
													</div>
												</button>
											);
										})}
									</div>
								</div>

								{selectedActiveSession && (
									<div className="grid gap-4 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:px-4">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<div className="text-sm font-semibold text-foreground">
													{selectedActiveSession.displayName ||
														selectedActiveSession.sessionId.slice(0, 8)}
												</div>
												<StatusBadge status={getOperationalStatus(selectedActiveSession)} />
											</div>
											<div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
												<div>
													{selectedActiveSession.currentTask && (
														<span className="truncate">{selectedActiveSession.currentTask}</span>
													)}
												</div>
												<div>
													<span className="text-foreground">Last activity:</span>{" "}
													{formatDuration(selectedActiveSession.lastActivityAt)}
												</div>
											</div>
										</div>
										<div className="flex items-start gap-2">
											<button
												type="button"
												onClick={() => navigate(`/sessions/${selectedActiveSession.sessionId}`)}
												className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
											>
												Open Workspace
											</button>
											<button
												type="button"
												onClick={() =>
													navigate(`/sessions/${selectedActiveSession.sessionId}?tab=activity`)
												}
												className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
											>
												Open Activity
											</button>
										</div>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Clear-filter chip: shown whenever a status card is selected. Anchors
			    the scroll-into-view target on narrow screens (toggleStatusFilter).
			    AGEN: the chip's count and listView's "Showing N of M" must read
			    from the same snapshot (operationalList.total) -- counts.waiting
			    (etc.) comes from a separate stats fetch that can race this one
			    and disagree by a row or two. */}
					<div ref={filterChipRef}>
						{filter === "active" && statusFilter && (
							<div className="mb-3 flex items-center gap-2">
								<span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
									{statusChipText({
										label: STATUS_CARD_LABEL[statusFilter],
										listTotal: operationalList.total,
										cardCount: counts[statusFilter],
										search: debouncedSearch,
									})}
									<button
										type="button"
										onClick={clearStatusFilter}
										className="ml-1 min-h-[44px] md:min-h-0 inline-flex items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										aria-label={`Clear the ${STATUS_CARD_LABEL[statusFilter]} filter`}
									>
										Clear
									</button>
								</span>
								{listView && (
									<span className="text-[11px] text-muted-foreground">{listView.showingText}</span>
								)}
							</div>
						)}
					</div>

					<h2 ref={listHeadingRef} tabIndex={-1} className="sr-only focus:outline-none">
						{listHeadingText}
					</h2>

					{/* Session Grid */}
					<div
						ref={gridRef}
						onPointerEnter={() => {
							gridInteractingRef.current = true;
						}}
						onPointerLeave={() => {
							gridInteractingRef.current = false;
						}}
						onFocus={() => {
							gridInteractingRef.current = true;
						}}
						onBlur={() => {
							gridInteractingRef.current = false;
						}}
					>
						<SessionGrid
							sessions={filtered}
							isLoading={gridIsLoading}
							quietWhenEmpty={listFailed || tabState === "more" || tabState === "recount"}
							filter={filter === "active" && statusFilter ? statusFilter : filter}
							searchQuery={search}
							machineView={{
								groupBy: groupByNow,
								stats: machineCountsByKey,
								machineKeys: machineKeysWithSessions(
									machineStats.groups,
									filter,
									filter === "active" ? statusFilter : null,
								),
								otherMachines: machineStats.groupsTruncated
									? { machines: machineStats.otherMachines, sessions: machineStats.otherTotal }
									: null,
								tab: filter,
								statusFilter,
								searchActive,
								currentHost: host,
								emptyState: machineEmpty,
								onShowAllOfHost: showAllOfHost,
								onViewAllMachines: viewAllMachines,
							}}
							team={
								ui.showGroupBy
									? {
											groupBy: groupByNow,
											owner,
											tab: filter,
											statusFilter,
											ownerStats: ownerGroupStats.groups,
											showOwnerChip: ownerChipVisible(ui.showOwnerChip, owner, groupBy),
											emptyState,
											searchActive,
											onShowAllOf: showAllOf,
											onViewEveryone: viewEveryone,
										}
									: undefined
							}
						/>
					</div>
					{listedTab &&
						tabState === "rows" &&
						(tabList.canLoadMore || searchActive || ui.showScope) && (
							<p className="mt-3 text-center text-xs text-hint">
								{tabListCaption({
									shown: filtered.length,
									badge: tabBadge,
									canLoadMore: tabList.canLoadMore,
									searchActive,
								})}
							</p>
						)}
					{listedTab && (tabState === "more" || tabState === "recount") && (
						<div className="mt-3 flex flex-col items-center gap-2 text-center text-sm text-hint">
							<p>
								{tabState === "more"
									? listedTab === "all"
										? `The newest sessions here are all archived; ${tabBadge ?? "some"} more are further back.`
										: `None of the newest sessions here are ${listedTab}; ${tabBadge ?? "some"} are further back.`
									: `The ${listedTab} count and the list are catching up.`}
							</p>
							<button
								type="button"
								onClick={() => {
									if (tabState === "more") tabList.loadMore();
									else {
										tabList.reload();
										focusList();
									}
								}}
								className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
							>
								{tabState === "more" ? "Look further back" : "Retry"}
							</button>
						</div>
					)}
					{statusFilter && operationalList.error && (
						<p role="alert" className="mt-3 text-center text-sm text-red-700 dark:text-red-400">
							{operationalList.error}{" "}
							<button
								type="button"
								onClick={() => {
									operationalList.reload();
									focusList();
								}}
								className={INLINE_RETRY}
							>
								Retry
							</button>
						</p>
					)}
					{listedTab && tabList.error && (
						<p role="alert" className="mt-3 text-center text-sm text-red-700 dark:text-red-400">
							{tabList.error}{" "}
							<button
								type="button"
								onClick={() => {
									tabList.reload();
									focusList();
								}}
								className={INLINE_RETRY}
							>
								Retry
							</button>
						</p>
					)}
					{listedTab && tabState === "rows" && tabList.canLoadMore && (
						<div className="mt-4 flex justify-center">
							<button
								type="button"
								onClick={() => tabList.loadMore()}
								className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
							>
								Load more
							</button>
						</div>
					)}
					{listView?.canLoadMore && (
						<div className="mt-4 flex justify-center">
							<button
								type="button"
								onClick={() => operationalList.loadMore()}
								className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
							>
								Load more
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

const STATUS_CARD_LABEL: Record<ActiveOperationalStatus, string> = {
	waiting: "Waiting",
	working: "Working",
	idle: "Idle",
	error: "Error",
};

/** ERROR strongest, WAITING attention, WORKING active, IDLE neutral (see StatusBadge). */
const STATUS_CARD_TONE: Record<ActiveOperationalStatus, "warn" | "danger" | "success" | "muted"> = {
	waiting: "warn",
	working: "success",
	idle: "muted",
	error: "danger",
};

/**
 * "What do these states mean?" — keyboard accessible (Escape dismisses,
 * click-outside dismisses), one line per state reusing STATE_HELP so the
 * popover text can never drift from the status cards' own tooltips.
 */
const STATUS_HELP_POPOVER_ID = "status-help-popover";

function StatusHelpPopover({
	open,
	onOpenChange,
	kind,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: ViewKind;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onOpenChange(false);
				// Escape is an explicit close -- return focus to the trigger.
				// A click-outside or tab-away close leaves focus wherever the
				// person just put it.
				triggerRef.current?.focus();
			}
		}
		function onPointerDown(e: PointerEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				onOpenChange(false);
			}
		}
		// AGEN: tabbing away (not just clicking away) must also close it.
		// relatedTarget is the element gaining focus; null/outside means
		// focus left the popover entirely.
		function onFocusOut(e: FocusEvent) {
			const next = e.relatedTarget as Node | null;
			if (containerRef.current && (!next || !containerRef.current.contains(next))) {
				onOpenChange(false);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown);
		containerRef.current?.addEventListener("focusout", onFocusOut);
		const container = containerRef.current;
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown);
			container?.removeEventListener("focusout", onFocusOut);
		};
	}, [open, onOpenChange]);

	return (
		<div ref={containerRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => onOpenChange(!open)}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? STATUS_HELP_POPOVER_ID : undefined}
				className="min-h-[44px] md:min-h-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
				What do these states mean?
			</button>
			{/* AGEN: normal flow, not `absolute` -- an absolutely positioned
			    panel directly below this trigger would float on top of the
			    status cards grid right underneath it. Rendering it in flow
			    pushes the grid down instead of covering it. role="dialog" +
			    aria-modal="false" (not aria-haspopup="true" with no popup
			    role) is the correct ARIA shape for a non-modal popover. */}
			{open && (
				<div
					id={STATUS_HELP_POPOVER_ID}
					// biome-ignore lint/a11y/useSemanticElements: a native <dialog> is
					// modal-first (showModal/close, built-in backdrop, focus trap) and
					// doesn't fit this always-rendered, open-prop-driven non-modal
					// popover; role="dialog" + aria-modal="false" is the correct ARIA
					// shape per the WAI-ARIA Dialog (Non-Modal) pattern.
					role="dialog"
					aria-modal="false"
					aria-label="What the operational states mean"
					className="mt-2 w-full max-w-72 rounded-md border border-border bg-card shadow-lg p-3 text-xs"
				>
					<dl className="space-y-2">
						{ACTIVE_OPERATIONAL_STATUSES.map((status) => (
							<div key={status}>
								<dt className="font-semibold text-foreground">{STATUS_CARD_LABEL[status]}</dt>
								<dd className="text-muted-foreground">{stateHelp(kind, status)}</dd>
							</div>
						))}
					</dl>
				</div>
			)}
		</div>
	);
}
