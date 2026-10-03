import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import type { DashboardStats, SessionTabCounts } from "../../shared/types.js";
import { activeCount } from "./dashboard-scope.js";

/**
 * What the status cards, tab badges and tiles show, and what a loaded list is
 * expected to add up to. Pure: the page reads the answers, so a badge and the
 * list under it always come from the same numbers.
 */
export type TabCounts = SessionTabCounts;

/** The server's stats; `tabCounts` is absent on a server that predates the tab filter. */
export type StatsWithTabs = Omit<DashboardStats, "tabCounts"> & { tabCounts?: TabCounts };

/** Shown in place of a count that has not arrived: a zero would be a claim. */
export const COUNT_PLACEHOLDER = "–";

export function displayCount(n: number | null | undefined): string | number {
	return n === null || n === undefined ? COUNT_PLACEHOLDER : n;
}

/** The three tab counts: the server's, or the numbers older servers were read as. */
function tabCountsOf(stats: StatsWithTabs): TabCounts {
	return (
		stats.tabCounts ?? {
			active: activeCount(stats.operational),
			completed: stats.completedCount,
			archived: stats.archivedCount,
		}
	);
}

/**
 * The number on a tab. Active narrows to the selected status card's own
 * count; All is everything in the scope except archived (what the All tab
 * lists). Undefined until the stats have arrived.
 */
export function tabBadgeCount(
	tab: string,
	stats: StatsWithTabs | null,
	status: ActiveOperationalStatus | null,
): number | undefined {
	if (!stats) return undefined;
	if (status !== null) return stats.operational[status];
	const counts = tabCountsOf(stats);
	if (tab === "active") return counts.active;
	if (tab === "completed") return counts.completed;
	if (tab === "archived") return counts.archived;
	return stats.total - counts.archived;
}

/**
 * The total the list on screen should reach, by the same stats the badges
 * come from: a status list its card, a tab its badge, All the scope's total
 * (the plain list counts archived rows the All tab then leaves out).
 */
export function expectedListTotal(input: {
	tab: string;
	status: ActiveOperationalStatus | null;
	stats: StatsWithTabs | null;
	/** A text search narrows the list below every count: there is nothing to compare it with. */
	searching?: boolean;
}): number | undefined {
	const { tab, status, stats, searching } = input;
	if (!stats || searching) return undefined;
	if (status !== null) return stats.operational[status];
	if (tab === "all") return stats.total;
	return tabBadgeCount(tab, stats, null);
}

/**
 * What the Live Sessions strip says about its numbers: how many are active, how many
 * working, how many need a person. Dashes until the counts have arrived, never zeros;
 * and when the strip holds fewer sessions than the scope has, it says so.
 */
export function liveStripText(input: {
	ready: boolean;
	shown: number;
	activeTotal: number;
	working: number;
	attention: number;
}): { count: string; working: string; attention: string | null } {
	if (!input.ready)
		return {
			count: `${COUNT_PLACEHOLDER} active`,
			working: `${COUNT_PLACEHOLDER} working`,
			attention: null,
		};
	return {
		count:
			input.shown < input.activeTotal
				? `showing the ${input.shown} most recent of ${input.activeTotal} active`
				: `${input.activeTotal} active`,
		working: `${input.working} working`,
		attention: input.attention > 0 ? `${input.attention} waiting or error` : null,
	};
}

/**
 * A short line for a tab whose name hides something: All leaves archived
 * sessions out (they have their own tab), which the tab's badge and Total
 * Sessions would otherwise seem to contradict.
 */
export function tabHint(tab: string): string | null {
	return tab === "all" ? "Everything except archived sessions." : null;
}
