import { AGENT_METADATA } from "../../shared/constants.js";
import {
	type ActiveOperationalStatus,
	type OperationalStatusInput,
	getOperationalStatus,
} from "../../shared/session-state.js";
import type { AgentType, HostStatsGroup, OwnerStatsGroup } from "../../shared/types.js";
import { HOST_UNKNOWN, type HostParam } from "../lib/host-scope.js";
import type { OwnerParam } from "../lib/owner-scope.js";
import { extractProjectName } from "../lib/utils.js";
import { groupByProjectKey, groupSessionsStable } from "./dashboard-view-state.js";

/**
 * How the dashboard groups its cards and what each group's header says.
 * Project is today's grouping, unchanged; User and Agent reuse the same stable
 * ordering machinery with a different key. Urgency never reorders groups.
 */
export type GroupBy = "project" | "user" | "agent" | "machine";

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
	project: "Project",
	user: "User",
	agent: "Agent",
	machine: "Machine",
};

export interface GroupableSession {
	cwd: string | null;
	agentType: string;
	isPinned: boolean;
	ownerUserId?: string | null;
	ownerKind?: "user" | "service" | "unassigned";
	/** Where the session runs, as the server filters and groups it; null is none, absent is unknown to this row. */
	machine?: string | null;
}

export interface DashboardGroup<T> {
	key: string;
	label: string;
	sessions: T[];
	pinned: boolean;
}

export interface GroupingContext {
	viewerUserId: string | null;
	/** A person's plain name for ordering and headers. */
	nameOf: (userId: string) => string;
}

export const SERVICE_GROUP_KEY = "service";
export const UNASSIGNED_GROUP_KEY = "unassigned";

const GROUP_BY_STORAGE_BASE = "agentpulse.dashboard.groupBy";

/** Stored per person, so a shared browser doesn't carry one person's grouping to the next. */
export function groupByStorageKey(userId: string | null): string {
	return `${GROUP_BY_STORAGE_BASE}.${userId ?? "anonymous"}`;
}

export function parseGroupBy(raw: string | null): GroupBy {
	return raw === "user" || raw === "agent" || raw === "machine" ? raw : "project";
}

function ownerKey(session: GroupableSession): string {
	if (session.ownerUserId) return session.ownerUserId;
	return session.ownerKind === "service" ? SERVICE_GROUP_KEY : UNASSIGNED_GROUP_KEY;
}

/** A machine group is keyed by its name, the sessions with no machine by the reserved filter value, so a group key is also the filter that selects it. */
function machineKey(session: GroupableSession): string {
	return session.machine?.trim() || HOST_UNKNOWN;
}

const UNKNOWN_MACHINE_GROUP_LABEL = "No machine reported";

/** By name without regard to case, ties by spelling (the server's order), the sessions with no machine last. */
function compareMachineGroups(
	a: { key: string; label: string },
	b: { key: string; label: string },
) {
	if (a.key === HOST_UNKNOWN || b.key === HOST_UNKNOWN) {
		return (a.key === HOST_UNKNOWN ? 1 : 0) - (b.key === HOST_UNKNOWN ? 1 : 0);
	}
	return (
		a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
		(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
	);
}

const SERVICE_GROUP_LABEL = "Service keys";
const UNASSIGNED_GROUP_LABEL = "Unassigned";

/** You, then other people, then service keys, then unassigned. */
function ownerRank(key: string, viewerUserId: string | null): number {
	if (viewerUserId !== null && key === viewerUserId) return 0;
	if (key === SERVICE_GROUP_KEY) return 2;
	if (key === UNASSIGNED_GROUP_KEY) return 3;
	return 1;
}

export function groupDashboardSessions<T extends GroupableSession>(
	sessions: readonly T[],
	groupBy: GroupBy,
	ctx: GroupingContext,
	options?: {
		/** Machine groups only: a group for each of these keys even before any of its cards are loaded, so headers don't appear above the reader as pages load. */
		machineKeys?: readonly string[];
	},
): { groups: DashboardGroup<T>[]; flat: boolean } {
	let groups: DashboardGroup<T>[];
	if (groupBy === "agent") {
		groups = groupSessionsStable(
			sessions,
			(s) => s.agentType,
			(key) => AGENT_METADATA[key as AgentType]?.label ?? key,
			(s) => s.isPinned,
		);
	} else if (groupBy === "machine") {
		groups = groupSessionsStable(
			sessions,
			machineKey,
			(key) => (key === HOST_UNKNOWN ? UNKNOWN_MACHINE_GROUP_LABEL : key),
			(s) => s.isPinned,
			compareMachineGroups,
		);
		const present = new Set(groups.map((g) => g.key));
		for (const key of options?.machineKeys ?? []) {
			if (present.has(key)) continue;
			groups.push({
				key,
				label: key === HOST_UNKNOWN ? UNKNOWN_MACHINE_GROUP_LABEL : key,
				sessions: [],
				pinned: false,
			});
		}
		groups.sort(compareMachineGroups);
	} else if (groupBy === "user") {
		const label = (key: string) =>
			key === SERVICE_GROUP_KEY
				? SERVICE_GROUP_LABEL
				: key === UNASSIGNED_GROUP_KEY
					? UNASSIGNED_GROUP_LABEL
					: ctx.nameOf(key);
		groups = groupSessionsStable(
			sessions,
			ownerKey,
			label,
			(s) => s.isPinned,
			(a, b) =>
				ownerRank(a.key, ctx.viewerUserId) - ownerRank(b.key, ctx.viewerUserId) ||
				a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
		);
	} else {
		groups = groupSessionsStable(
			sessions,
			groupByProjectKey,
			(project) => project,
			(s) => s.isPinned,
		);
	}
	// One owner's cards still carry that owner's header, so who they are is never a guess;
	// a single project or agent has nothing to tell apart.
	return { groups, flat: groupBy === "user" ? groups.length === 0 : groups.length <= 1 };
}

/** The server's per-owner counts keyed the way groups are, so a header can look its own up. */
export function ownerStatsByKey(groups: readonly OwnerStatsGroup[]): Map<string, OwnerStatsGroup> {
	return new Map(
		groups.map((group) => [
			group.ownerUserId ??
				(group.ownerKind === "service" ? SERVICE_GROUP_KEY : UNASSIGNED_GROUP_KEY),
			group,
		]),
	);
}

/** The server's per-machine counts keyed the way machine groups are, so a header can look its own up. */
export function hostStatsByKey(groups: readonly HostStatsGroup[]): Map<string, HostStatsGroup> {
	return new Map(groups.map((group) => [group.host ?? HOST_UNKNOWN, group]));
}

/** The machines that get a header on this tab (or under this status card): those the server counted with sessions there, in the server's order. */
export function machineKeysWithSessions(
	groups: readonly HostStatsGroup[] | null,
	tab: string,
	statusFilter: ActiveOperationalStatus | null,
): string[] {
	return (groups ?? [])
		.filter((group) => (ownerGroupTotal(group, tab, statusFilter) ?? 0) > 0)
		.map((group) => group.host ?? HOST_UNKNOWN);
}

// ── Headers ─────────────────────────────────────────────────────────────────

export interface GroupHeader {
	title: string;
	/** The full project path, under the title; project groups only. */
	path: string | null;
	countText: string;
	working: number;
	waiting: number;
	showAll: { ownerId: string; label: string; ariaLabel: string } | null;
	/** Machine groups: narrow the view to this machine (`host` is the filter value that selects it). */
	showAllHost: { host: HostParam; label: string; ariaLabel: string } | null;
}

export interface HeaderContext extends GroupingContext {
	/** Team mode counts "shown"; solo keeps "N sessions". */
	teamHeaders: boolean;
	/** The server's per-owner counts, by group key; null until they arrive (or when not asked for). */
	ownerStats: ReadonlyMap<string, OwnerStatsGroup> | null;
	tab: string;
	statusFilter: ActiveOperationalStatus | null;
	currentOwner: OwnerParam;
	/** The server's per-machine counts, by group key; null until they arrive (or when not asked for). */
	machineStats?: ReadonlyMap<string, HostStatsGroup> | null;
	/** The machine the view is already narrowed to (empty is every machine). */
	currentHost?: HostParam;
	/** A text search is on: counts are matches, and "show all of theirs" would contradict it. */
	searchActive?: boolean;
}

/** The server's count that matches what the current tab and status card are showing, for "N shown of M". Null when it has none. */
export function ownerGroupTotal(
	group: Omit<OwnerStatsGroup, "ownerUserId" | "ownerKind">,
	tab: string,
	statusFilter: ActiveOperationalStatus | null,
): number | null {
	if (statusFilter) return group[statusFilter];
	// This owner's size of the same tab the list shows; an older server sends no tab counts.
	const tabs = group.tabCounts as HostStatsGroup["tabCounts"] | undefined;
	if (tab === "active") return tabs?.active ?? group.active;
	if (tab === "completed") return tabs?.completed ?? group.completed;
	if (tab === "archived") return tabs?.archived ?? null;
	return tabs ? group.total - tabs.archived : null;
}

function shownCount(count: number, teamHeaders: boolean, searching = false): string {
	if (teamHeaders) return searching ? `${count} matching` : `${count} shown`;
	return `${count} session${count !== 1 ? "s" : ""}`;
}

function countStatuses(sessions: readonly OperationalStatusInput[]): {
	working: number;
	waiting: number;
} {
	let working = 0;
	let waiting = 0;
	for (const session of sessions) {
		const status = getOperationalStatus(session);
		if (status === "working") working += 1;
		else if (status === "waiting") waiting += 1;
	}
	return { working, waiting };
}

function showAllAriaLabel(
	key: string,
	isSelf: boolean,
	nameOf: (userId: string) => string,
): string {
	if (key === SERVICE_GROUP_KEY) return "Show all service-key sessions";
	if (key === UNASSIGNED_GROUP_KEY) return "Show all unassigned sessions";
	return isSelf ? "Show all of your sessions" : `Show all of ${nameOf(key)}'s sessions`;
}

function machineHeader<T extends GroupableSession>(
	group: DashboardGroup<T>,
	ctx: HeaderContext,
	fromCards: { working: number; waiting: number },
): GroupHeader {
	const shown = group.sessions.length;
	const searching = ctx.searchActive === true;
	const stats = ctx.machineStats?.get(group.key) ?? null;
	const total = stats ? ownerGroupTotal(stats, ctx.tab, ctx.statusFilter) : null;
	const moreThanShown = total !== null && total > shown;
	// As for an owner: the machine's own working and waiting totals describe its
	// active sessions, so they stand in only for the Active tab with no status card.
	const machineActiveTotals =
		stats !== null && !searching && ctx.tab === "active" && !ctx.statusFilter;
	const named = group.key !== HOST_UNKNOWN;
	return {
		title: group.label,
		path: null,
		countText: searching
			? shownCount(shown, true, true)
			: moreThanShown
				? `${shown} shown of ${total}`
				: shownCount(shown, ctx.teamHeaders),
		working: machineActiveTotals ? stats.working : fromCards.working,
		waiting: machineActiveTotals ? stats.waiting : fromCards.waiting,
		showAll: null,
		showAllHost:
			ctx.currentHost !== group.key && !searching && moreThanShown
				? {
						host: group.key,
						label: "Show all",
						ariaLabel: named
							? `Show all sessions on ${group.label}`
							: "Show all sessions with no machine reported",
					}
				: null,
	};
}

export function groupHeader<T extends GroupableSession & OperationalStatusInput>(
	group: DashboardGroup<T>,
	groupBy: GroupBy,
	ctx: HeaderContext,
): GroupHeader {
	const shown = group.sessions.length;
	const fromCards = countStatuses(group.sessions);

	if (groupBy === "project") {
		return {
			title: extractProjectName(group.key),
			path: group.key,
			countText: shownCount(shown, ctx.teamHeaders, ctx.searchActive),
			...fromCards,
			showAll: null,
			showAllHost: null,
		};
	}
	if (groupBy === "agent") {
		return {
			title: group.label,
			path: null,
			countText: shownCount(shown, ctx.teamHeaders, ctx.searchActive),
			...fromCards,
			showAll: null,
			showAllHost: null,
		};
	}

	if (groupBy === "machine") return machineHeader(group, ctx, fromCards);

	const isPerson = group.key !== SERVICE_GROUP_KEY && group.key !== UNASSIGNED_GROUP_KEY;
	const isSelf = isPerson && ctx.viewerUserId !== null && group.key === ctx.viewerUserId;
	const searching = ctx.searchActive === true;
	const stats = ctx.ownerStats?.get(group.key) ?? null;
	const total = stats ? ownerGroupTotal(stats, ctx.tab, ctx.statusFilter) : null;
	const alreadyThisOwner = ctx.currentOwner === group.key || (isSelf && ctx.currentOwner === "me");
	const moreThanShown = total === null || total > shown;
	// The owner's working and waiting totals describe their active sessions: they
	// match only the Active tab with no status card; elsewhere the cards shown are the truth.
	const ownerActiveTotals =
		stats !== null && !searching && ctx.tab === "active" && !ctx.statusFilter;
	return {
		title: isSelf ? `${group.label} (you)` : group.label,
		path: null,
		countText: searching
			? shownCount(shown, true, true)
			: total !== null && total > shown
				? `${shown} shown of ${total}`
				: `${shown} shown`,
		working: ownerActiveTotals ? stats.working : fromCards.working,
		waiting: ownerActiveTotals ? stats.waiting : fromCards.waiting,
		showAll:
			!alreadyThisOwner && !searching && moreThanShown
				? {
						ownerId: group.key,
						label: "Show all",
						ariaLabel: showAllAriaLabel(group.key, isSelf, ctx.nameOf),
					}
				: null,
		showAllHost: null,
	};
}
