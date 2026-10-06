import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	type ActiveOperationalStatus,
	compareOperational,
	getOperationalStatus,
} from "../../shared/session-state.js";
import type { HostStatsGroup, OwnerStatsGroup, Session } from "../../shared/types.js";
import { useDirectoryInitials } from "../hooks/useDirectoryInitials.js";
import { useNoteUnknownOwners } from "../hooks/useNoteUnknownOwners.js";
import { isAiDisabledError } from "../lib/api-errors.js";
import { type SessionIntelligence, api } from "../lib/api.js";
import type { HostParam } from "../lib/host-scope.js";
import { ownerChip } from "../lib/owner-chip.js";
import { ownerLabel } from "../lib/owner-label.js";
import type { OwnerParam } from "../lib/owner-scope.js";
import { cn } from "../lib/utils.js";
import type { EmptyState } from "../pages/dashboard-empty.js";
import {
	type GroupBy,
	type GroupHeader,
	groupDashboardSessions,
	groupHeader,
	unlistedMachineCount,
} from "../pages/dashboard-groups.js";
import {
	MAX_POINTER_HOLD_MS,
	UNDO_WINDOW_MS,
	reconcileHeldOrder,
	shouldRunHeldRefresh,
} from "../pages/dashboard-view-state.js";
import { useUserStore } from "../stores/user-store.js";
import { useUsersStore } from "../stores/users-store.js";
import { SessionCard } from "./SessionCard.js";

/**
 * Sort-relevant fields as a single comparable string, so a plain
 * reference/value change elsewhere on the session (e.g. lastActivityAt
 * ticking, or an unrelated metadata write) doesn't look like a "position
 * changed" event — only isPinned or the derived operational status moving
 * counts.
 */
function sortRelevantKey(session: Session): string {
	return `${session.isPinned ? 1 : 0}:${getOperationalStatus(session)}`;
}

/**
 * Holds each card's display position for UNDO_WINDOW_MS after its
 * sort-relevant fields change (AGEN) — e.g. acknowledging a WAITING
 * session into IDLE must not move the card out from under its own Undo
 * banner. Combined with `extraHold` (hover/focus anywhere in the grid) in
 * useHeldSortOrder below.
 */
function useRecentChangeHold(sessions: readonly Session[]): () => boolean {
	const prevKeysRef = useRef<Map<string, string>>(new Map());
	const changedAtRef = useRef<Map<string, number>>(new Map());

	const now = Date.now();
	for (const session of sessions) {
		const key = sortRelevantKey(session);
		const prevKey = prevKeysRef.current.get(session.sessionId);
		if (prevKey !== undefined && prevKey !== key) {
			changedAtRef.current.set(session.sessionId, now);
		}
		prevKeysRef.current.set(session.sessionId, key);
	}
	// Garbage-collect sessions no longer present.
	const presentIds = new Set(sessions.map((s) => s.sessionId));
	for (const id of [...prevKeysRef.current.keys()]) {
		if (!presentIds.has(id)) {
			prevKeysRef.current.delete(id);
			changedAtRef.current.delete(id);
		}
	}

	return () => {
		const nowMs = Date.now();
		for (const changedAt of changedAtRef.current.values()) {
			if (nowMs - changedAt < UNDO_WINDOW_MS) return true;
		}
		return false;
	};
}

/**
 * Freezes display order while the grid is hovered/focused OR any card's
 * sort-relevant fields changed within the last UNDO_WINDOW_MS (AGEN) — see
 * reconcileHeldOrder for how the held order is computed from a fresh sort.
 * Returns the session objects in the order to actually render, plus the
 * hover/focus handlers to spread onto the grid container.
 *
 * The pointer/focus hold is bounded (shouldRunHeldRefresh, MAX_POINTER_HOLD_MS):
 * a pointer that enters and then rests (no further move/leave) used to hold
 * the order forever, because `interactingRef` only flipped on enter/leave
 * and mutating a ref never triggers a re-render on its own -- a card that
 * became WAITING could sit out of order until some unrelated poll happened
 * to re-render the grid. `bump()` forces that re-render immediately on
 * enter/leave/focus/blur, and a timer forces one more at the bound so a
 * resting pointer can't hold the order past MAX_POINTER_HOLD_MS.
 */
function useHeldSortOrder(sorted: readonly Session[]) {
	const orderRef = useRef<string[]>([]);
	const interactingRef = useRef(false);
	const interactStartRef = useRef<number | null>(null);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [, setRenderTick] = useState(0);
	const isRecentlyChanged = useRecentChangeHold(sorted);

	const bump = useCallback(() => setRenderTick((t) => t + 1), []);

	const clearHoldTimer = useCallback(() => {
		if (holdTimerRef.current) {
			clearTimeout(holdTimerRef.current);
			holdTimerRef.current = null;
		}
	}, []);

	const startInteracting = useCallback(() => {
		interactingRef.current = true;
		interactStartRef.current = Date.now();
		clearHoldTimer();
		holdTimerRef.current = setTimeout(bump, MAX_POINTER_HOLD_MS);
		bump();
	}, [bump, clearHoldTimer]);

	const stopInteracting = useCallback(() => {
		interactingRef.current = false;
		interactStartRef.current = null;
		clearHoldTimer();
		bump();
	}, [bump, clearHoldTimer]);

	useEffect(() => clearHoldTimer, [clearHoldTimer]);

	const heldMs = interactStartRef.current != null ? Date.now() - interactStartRef.current : 0;
	const pointerHeld = !shouldRunHeldRefresh({
		isInteracting: interactingRef.current,
		heldMs,
		maxHoldMs: MAX_POINTER_HOLD_MS,
	});
	const isHeld = pointerHeld || isRecentlyChanged();
	const freshIds = sorted.map((s) => s.sessionId);
	const nextOrder = isHeld ? reconcileHeldOrder(orderRef.current, freshIds) : freshIds;
	orderRef.current = nextOrder;

	const byId = new Map(sorted.map((s) => [s.sessionId, s]));
	const ordered = nextOrder.map((id) => byId.get(id)).filter((s): s is Session => s != null);

	const interactionHandlers = {
		onPointerEnter: startInteracting,
		onPointerLeave: stopInteracting,
		onFocus: startInteracting,
		onBlur: stopInteracting,
	};

	return { ordered, interactionHandlers };
}

interface SessionGridProps {
	sessions: Session[];
	isLoading: boolean;
	/** The active filter tab so the empty state can offer context-aware copy. */
	filter?: string;
	/** Active search text (AGEN) — an empty result under a search says so by name instead of the generic "no sessions" copy. */
	searchQuery?: string;
	/** The page shows its own explanation for an empty list (a tab still being looked through): draw nothing here. */
	quietWhenEmpty?: boolean;
	/** Team mode: what the cards are grouped by, and the context group headers and owner chips need. Absent in solo, which groups by project exactly as before. */
	team?: TeamGridProps;
	/** The machine filter and grouping, in solo and in a team alike. Absent: the grid groups by project (or the team's choice) and an empty view uses its own copy. */
	machineView?: MachineGridProps;
}

export interface MachineGridProps {
	/** What the cards are grouped by when there is no team (a team's own `groupBy` wins). */
	groupBy: GroupBy;
	/** The server's per-machine counts, by group key; null until they arrive. */
	stats: ReadonlyMap<string, HostStatsGroup> | null;
	tab: string;
	statusFilter: ActiveOperationalStatus | null;
	searchActive: boolean;
	/** The machines that get a header on this tab even before their cards are loaded (the server's counts), in order. */
	machineKeys: readonly string[];
	/** Machines the server rolled up beyond its listed ones (it cut the list to the busiest), or null. */
	otherMachines: { machines: number; sessions: number } | null;
	/** The machine the view is already narrowed to. */
	currentHost: HostParam;
	/** Set when the view is narrowed to a machine and nothing matches: it names the machine and offers the way back. */
	emptyState: EmptyState | null;
	onShowAllOfHost: (host: HostParam) => void;
	onViewAllMachines: () => void;
}

export interface TeamGridProps {
	groupBy: GroupBy;
	owner: OwnerParam;
	tab: string;
	statusFilter: ActiveOperationalStatus | null;
	/** The server's per-owner counts, by group key. */
	ownerStats: ReadonlyMap<string, OwnerStatsGroup> | null;
	/** An owner chip on each card (off when the view is already one owner, or grouped by user). */
	showOwnerChip: boolean;
	/** An empty narrowed view says what it is instead of the generic copy. */
	emptyState: EmptyState | null;
	/** A text search is on: headers count matches. */
	searchActive: boolean;
	onShowAllOf: (ownerId: string) => void;
	onViewEveryone: () => void;
}

/** Set once the server says the AI features are off: later id sets don't ask again. */
let intelligenceUnavailable = false;

function useSessionIntelligence(
	sessions: Session[],
): Record<string, SessionIntelligence | undefined> {
	const [map, setMap] = useState<Record<string, SessionIntelligence | undefined>>({});
	const activeIds = sessions
		.filter((s) => s.status === "active" || s.status === "idle")
		.map((s) => s.sessionId);
	const key = activeIds.sort().join(",");

	useEffect(() => {
		if (activeIds.length === 0 || intelligenceUnavailable) return;
		let cancelled = false;
		api
			.getIntelligenceBatch(activeIds)
			.then((res) => {
				if (cancelled) return;
				setMap(res.intelligence ?? {});
			})
			.catch((err) => {
				// Silent: the classifier may be off; once the server says so, stop asking.
				if (isAiDisabledError(err)) intelligenceUnavailable = true;
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	return map;
}

export function SessionGrid({
	sessions,
	isLoading,
	filter,
	searchQuery,
	quietWhenEmpty,
	team,
	machineView,
}: SessionGridProps) {
	const intelligence = useSessionIntelligence(sessions);
	const viewerUserId = useUserStore((s) => s.userId);
	const directory = useUsersStore((s) => s.byId);
	useNoteUnknownOwners(team ? sessions.map((session) => session.ownerUserId) : []);
	const nameOf = useCallback(
		(userId: string) => ownerLabel(directory[userId], userId, { selfId: viewerUserId }),
		[directory, viewerUserId],
	);
	const initialsById = useDirectoryInitials(directory);
	const chipFor = (session: Session) =>
		team?.showOwnerChip
			? ownerChip(session, {
					viewerUserId,
					lookup: (id) => directory[id],
					initialsById,
				})
			: null;

	// Card order within a group: pinned first, then operational status
	// (waiting → error → working → idle → completed), then by last activity.
	// This is the only place urgency affects ordering now — the groups
	// themselves keep a stable pinned-then-name order (groupSessionsStable),
	// not an urgency-based reshuffle (AGEN: urgency is carried by the
	// per-project chips and the status filter instead).
	const sorted = [...sessions].sort((a, b) => {
		if (a.isPinned && !b.isPinned) return -1;
		if (!a.isPinned && b.isPinned) return 1;
		return compareOperational(a, b);
	});

	// AGEN: hooks run unconditionally, before the isLoading/empty early
	// returns below, so the hold state survives across a loading transition.
	const { ordered, interactionHandlers } = useHeldSortOrder(sorted);

	if (isLoading) {
		return (
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
				{Array.from({ length: 4 }).map((_, i) => (
					<div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
						<div className="h-4 bg-muted rounded w-3/4 mb-3" />
						<div className="h-3 bg-muted rounded w-1/2 mb-2" />
						<div className="h-3 bg-muted rounded w-2/3" />
					</div>
				))}
			</div>
		);
	}

	if (sessions.length === 0 && quietWhenEmpty) return null;

	const narrowedEmpty = machineView?.emptyState ?? team?.emptyState;
	if (sessions.length === 0 && narrowedEmpty) {
		return (
			<NarrowedEmptyState
				state={narrowedEmpty}
				onViewEveryone={team?.onViewEveryone}
				onViewAllMachines={machineView?.onViewAllMachines}
			/>
		);
	}

	if (sessions.length === 0) {
		// `filter` is a tab id (active / completed / archived / all) or one of the
		// operational statuses (waiting / error / working / idle) when a status
		// card is selected; both read naturally as "No <filter> sessions".
		const trimmedQuery = searchQuery?.trim();
		const emptyHeading = trimmedQuery
			? `No ${filter && filter !== "all" ? `${filter} ` : ""}sessions match "${trimmedQuery}"`
			: filter && filter !== "all"
				? `No ${filter} sessions`
				: "No sessions yet";
		const emptySub = trimmedQuery
			? "Try a different search term, or clear it to see everything in this view."
			: filter === "archived"
				? "Archived sessions will appear here once you archive them."
				: filter && filter !== "all"
					? "Try a different status card or filter tab."
					: "Start an agent session to see it here. Follow the setup guide to wire up your first hook.";
		return (
			<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
				<svg
					className="w-16 h-16 mb-4 opacity-30"
					aria-hidden="true"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
					/>
				</svg>
				<p className="text-lg font-medium mb-1">{emptyHeading}</p>
				<p className="text-sm">{emptySub}</p>
			</div>
		);
	}

	const groupBy = team?.groupBy ?? machineView?.groupBy ?? "project";
	const { groups, flat } = groupDashboardSessions(
		ordered,
		groupBy,
		{ viewerUserId, nameOf },
		{ machineKeys: groupBy === "machine" ? (machineView?.machineKeys ?? []) : [] },
	);

	// Single project: flat grid. The hover/focus/recent-ack hold handlers
	// live on this container (and the multi-project one below) so a card
	// never moves out from under the pointer or its own Undo banner.
	if (flat) {
		return (
			<div
				className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4"
				{...interactionHandlers}
			>
				{ordered.map((session) => (
					<SessionCard
						key={session.sessionId}
						session={session}
						intelligence={intelligence[session.sessionId]}
						ownerChip={chipFor(session)}
					/>
				))}
			</div>
		);
	}

	const unlisted = machineView?.otherMachines
		? unlistedMachineCount(machineView.otherMachines.machines, groups, machineView.machineKeys)
		: 0;
	// Several groups, in stable order (see groupDashboardSessions).
	return (
		<div className="space-y-5 md:space-y-6" {...interactionHandlers}>
			{groups.map((group) => {
				const header = groupHeader(group, groupBy, {
					viewerUserId,
					nameOf,
					teamHeaders: team !== undefined,
					ownerStats: team?.ownerStats ?? null,
					tab: team?.tab ?? machineView?.tab ?? "active",
					statusFilter: team?.statusFilter ?? machineView?.statusFilter ?? null,
					currentOwner: team?.owner ?? "all",
					machineStats: machineView?.stats ?? null,
					currentHost: machineView?.currentHost ?? "",
					searchActive: team?.searchActive ?? machineView?.searchActive ?? false,
				});
				return (
					<div key={group.key} className={cn(group.sessions.length === 0 && "!mt-2 md:!mt-3")}>
						<GroupHeaderRow
							header={header}
							onShowAllOf={team?.onShowAllOf}
							onShowAllOfHost={machineView?.onShowAllOfHost}
							compact={group.sessions.length === 0}
						/>
						{group.sessions.length > 0 && (
							<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
								{group.sessions.map((session) => (
									<SessionCard
										key={session.sessionId}
										session={session}
										intelligence={intelligence[session.sessionId]}
										ownerChip={chipFor(session)}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}
			{groupBy === "machine" && machineView?.otherMachines && unlisted > 0 && (
				<p className="text-xs text-hint">
					{unlisted} more machine{unlisted === 1 ? "" : "s"} aren't listed here: only the busiest
					machines, and any whose sessions are loaded below, get a header.
				</p>
			)}
		</div>
	);
}

const SHOW_ALL_CLASS = cn(
	"inline-flex min-h-[44px] items-center rounded px-1 text-xs font-medium text-primary underline underline-offset-2 hover:text-foreground md:min-h-[24px] [@media(pointer:coarse)]:min-h-[44px]",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

/** The header over one group. For project groups in solo this is the markup the dashboard has always had. */
function GroupHeaderRow({
	header,
	onShowAllOf,
	onShowAllOfHost,
	compact = false,
}: {
	header: GroupHeader;
	onShowAllOf?: (ownerId: string) => void;
	onShowAllOfHost?: (host: HostParam) => void;
	/** A header with no cards under it (its sessions aren't loaded yet): one wrapping row, not a stack, so many of them don't push the first card far down on a phone. */
	compact?: boolean;
}) {
	const showAll = header.showAll;
	const showAllHost = header.showAllHost;
	return (
		<div
			className={cn(
				compact
					? "flex flex-row flex-wrap items-center gap-x-2 gap-y-0.5"
					: "flex flex-col items-start gap-1.5 mb-3 md:flex-row md:items-center md:gap-2",
			)}
		>
			<h3
				title={header.title}
				className="max-w-full break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]"
			>
				{header.title}
			</h3>
			<span className="text-xs text-muted-foreground">{header.countText}</span>
			{header.waiting > 0 && (
				<span className="text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 bg-amber-500/15 border border-amber-500/20 rounded px-1.5 py-0">
					{header.waiting} waiting
				</span>
			)}
			{header.working > 0 && (
				<span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
					{header.working} working
				</span>
			)}
			{header.path !== null && (
				<span className="text-[10px] text-muted-foreground break-all md:truncate md:max-w-xs">
					{header.path}
				</span>
			)}
			{showAll && onShowAllOf && (
				<button
					type="button"
					onClick={() => onShowAllOf(showAll.ownerId)}
					aria-label={showAll.ariaLabel}
					className={SHOW_ALL_CLASS}
				>
					{showAll.label}
				</button>
			)}
			{showAllHost && onShowAllOfHost && (
				<button
					type="button"
					onClick={() => onShowAllOfHost(showAllHost.host)}
					aria-label={showAllHost.ariaLabel}
					className={SHOW_ALL_CLASS}
				>
					{showAllHost.label}
				</button>
			)}
		</div>
	);
}

/** An empty narrowed view (Mine, one person, an ownerless kind) says what it is and what to do. */
function NarrowedEmptyState({
	state,
	onViewEveryone,
	onViewAllMachines,
}: {
	state: EmptyState;
	onViewEveryone?: () => void;
	onViewAllMachines?: () => void;
}) {
	return (
		<div className="flex flex-col items-center justify-center px-4 py-16 text-center">
			<p className="mb-1 text-lg font-medium text-foreground">{state.heading}</p>
			{state.body && <p className="max-w-md text-sm text-hint">{state.body}</p>}
			{state.actions.length > 0 && (
				<div className="mt-4 flex flex-wrap items-center justify-center gap-2">
					{state.actions.includes("setup") && (
						<Link
							to="/setup"
							className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:min-h-0"
						>
							Set up my machine
						</Link>
					)}
					{state.actions.includes("allMachines") && onViewAllMachines && (
						<button
							type="button"
							onClick={onViewAllMachines}
							className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent md:min-h-0"
						>
							Show all machines
						</button>
					)}
					{state.actions.includes("viewEveryone") && onViewEveryone && (
						<button
							type="button"
							onClick={onViewEveryone}
							className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent md:min-h-0"
						>
							View everyone's sessions
						</button>
					)}
				</div>
			)}
		</div>
	);
}
