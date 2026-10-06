import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN, type HostParam } from "../lib/host-scope.js";
import type { EmptyState } from "./dashboard-empty.js";
import { ownerGroupTotal } from "./dashboard-groups.js";
import type { GroupBy } from "./dashboard-groups.js";

/**
 * What the Machine filter offers, when it shows at all, and what the page says
 * about it. Pure: components read the answers. A machine is where a session
 * runs as the dashboard shows it (the supervisor's host, else the name a relay
 * reported, else none); the choice narrows the view and decides nothing about
 * who may see or change a session.
 */
export const ALL_MACHINES_LABEL = "All machines";
/** The one name for the sessions whose events reported no machine, in the select, the headers, the empty state and the docs. */
export const UNKNOWN_MACHINE_LABEL = "No machine reported";

export interface MachineOption {
	value: HostParam;
	label: string;
	/** A line that says something (how many machines aren't listed) and can't be chosen. */
	disabled?: boolean;
}

/** A machine's name for people: unknown is a phrase, every machine is its own label. */
export function machineLabel(host: HostParam): string {
	if (host === HOST_ALL) return ALL_MACHINES_LABEL;
	return host === HOST_UNKNOWN ? UNKNOWN_MACHINE_LABEL : host;
}

function withCount(label: string, count: number | null): string {
	return count === null ? label : `${label} (${count})`;
}

/**
 * Every machine, then each one the server counted (by name, as it sent them)
 * with how many sessions it has in the tab (or status card) on screen, then the
 * sessions with no machine reported while there are any. A chosen machine the
 * server doesn't list is still offered, so the select never shows something it
 * isn't: with a zero when the list is complete, with no count when the list was
 * cut to the busiest machines (it may simply be one of those). A cut list ends
 * in a line saying how many machines aren't listed. Before the counts arrive only
 * every machine and the current choice are offered, without counts.
 */
export function machineOptions(
	groups: readonly HostStatsGroup[] | null,
	current: HostParam,
	view: {
		tab: string;
		statusFilter: ActiveOperationalStatus | null;
		groupsTruncated: boolean;
		otherMachines: number;
	},
): MachineOption[] {
	const options: MachineOption[] = [{ value: HOST_ALL, label: ALL_MACHINES_LABEL }];
	const countOf = (group: HostStatsGroup): number | null =>
		ownerGroupTotal(group, view.tab, view.statusFilter);
	const named = (groups ?? []).filter((g) => g.host !== null) as Array<
		HostStatsGroup & { host: string }
	>;
	for (const g of named) options.push({ value: g.host, label: withCount(g.host, countOf(g)) });
	const unlistedCount = groups === null || view.groupsTruncated ? null : 0;
	if (current !== HOST_ALL && current !== HOST_UNKNOWN && !named.some((g) => g.host === current)) {
		options.push({ value: current, label: withCount(current, unlistedCount) });
	}
	const none = groups?.find((g) => g.host === null);
	if (none || current === HOST_UNKNOWN) {
		options.push({
			value: HOST_UNKNOWN,
			label: withCount(UNKNOWN_MACHINE_LABEL, none ? countOf(none) : unlistedCount),
		});
	}
	if (view.groupsTruncated && view.otherMachines > 0) {
		options.push({
			value: "\u0000more",
			label: `${view.otherMachines} more machine${view.otherMachines === 1 ? "" : "s"} not listed`,
			disabled: true,
		});
	}
	return options;
}

/**
 * Whether the control is drawn. With one machine (or none reported) there is
 * nothing to tell apart, so the page stays as it was; as soon as two groups
 * exist anywhere in the install it appears. `machineCount` is the last known
 * count of machines across everyone (the sessions with no machine reported count
 * as one), not the owner-scoped one, so choosing another owner can't make the
 * control come and go, and it stays what it was while a new answer loads. It also
 * stays while a machine is chosen or the cards are grouped by machine, so the way
 * back is never taken away by a count that dropped.
 */
export function machineControlVisible(input: {
	machineCount: number | null;
	host: HostParam;
	groupBy: GroupBy;
}): boolean {
	if (input.host !== HOST_ALL || input.groupBy === "machine") return true;
	return input.machineCount !== null && input.machineCount > 1;
}

/** The waiting sessions on every machine but the chosen one, from the counts already fetched; 0 with every machine chosen or before they arrive. */
export function waitingOnOtherMachines(
	groups: readonly HostStatsGroup[] | null,
	host: HostParam,
): number {
	if (groups === null || host === HOST_ALL) return 0;
	const chosen = host === HOST_UNKNOWN ? null : host;
	return groups.filter((g) => g.host !== chosen).reduce((sum, g) => sum + g.waiting, 0);
}

/**
 * The one line by the stat cards: which machine the numbers are for, and what is
 * waiting elsewhere. When the machine list was cut, the figure counts only the
 * machines that are listed, so it is a floor ("At least"), and nothing is said
 * when it is zero (unlisted machines might still have some).
 */
export function machineScopeText(
	host: HostParam,
	waitingElsewhere: number,
	atLeast: boolean,
): string {
	const scope =
		host === HOST_UNKNOWN
			? "Showing only sessions with no machine reported."
			: `Showing ${host} only.`;
	if (waitingElsewhere <= 0) return scope;
	const n = atLeast ? `At least ${waitingElsewhere}` : `${waitingElsewhere}`;
	return `${scope} ${n} waiting on other machines.`;
}

/** The "N more active across the team" line; under a machine filter it says whose machine, so a machine-scoped number doesn't read as team-wide. */
export function teamLineText(count: number, host: HostParam): string {
	const base = `${count} more active across the team`;
	if (host === HOST_ALL) return `${base}.`;
	return host === HOST_UNKNOWN ? `${base} with no machine reported.` : `${base} on ${host}.`;
}

/** Whether a row (a pushed session) is on a machine the control's counts don't list yet, so they should be asked for again now. */
export function hasUnlistedMachine(
	rows: ReadonlyArray<{ machine?: string | null }>,
	groups: readonly HostStatsGroup[] | null,
): boolean {
	if (groups === null) return false;
	const listed = new Set(groups.map((g) => g.host));
	return rows.some((row) => {
		if (row.machine === undefined) return false;
		return !listed.has(row.machine?.trim() || null);
	});
}

export function machineAnnouncement(host: HostParam): string {
	if (host === HOST_ALL) return "Showing sessions on every machine.";
	if (host === HOST_UNKNOWN) return "Showing sessions with no machine reported.";
	return `Showing sessions on ${host}.`;
}

/** What Group by offers: users only in a team, machines once the Machine control is on offer (see machineControlVisible). */
export function groupByOptions(input: { team: boolean; machineControl: boolean }): GroupBy[] {
	if (input.team) {
		return input.machineControl
			? ["project", "user", "agent", "machine"]
			: ["project", "user", "agent"];
	}
	return input.machineControl ? ["project", "machine", "agent"] : ["project", "agent"];
}

/**
 * Whether the Group by and scratch controls are drawn together. A team always has
 * them. Solo keeps the page it had (the scratch toggle alone) unless there are
 * two machines to choose between, or a grouping other than project is on, so it
 * can always be undone.
 */
export function viewControlsVisible(input: {
	team: boolean;
	machineControl: boolean;
	groupBy: GroupBy;
}): boolean {
	return input.team || input.machineControl || input.groupBy !== "project";
}

const TAB_WORD: Record<string, string> = {
	active: "active",
	completed: "completed",
	archived: "archived",
};

/**
 * The empty state for a view narrowed to a machine, or null where the grid's own
 * copy is right (no machine chosen, a search is on, or the tab's badge says there
 * is something, so it is never called empty). It names the machine and offers
 * the way back to every machine.
 */
export function machineEmptyState(input: {
	host: HostParam;
	tab: string;
	statusFilter: ActiveOperationalStatus | null;
	searchActive: boolean;
	/** Every session in this view, whatever the tab. */
	scopeTotal: number;
	tabCount?: number;
	/** Whose sessions is also narrowed (Mine, a person, service keys, unassigned). */
	ownerNarrowed: boolean;
}): EmptyState | null {
	if (input.host === HOST_ALL || input.searchActive || (input.tabCount ?? 0) > 0) return null;
	const where = input.host === HOST_UNKNOWN ? "with no machine reported" : `on ${input.host}`;
	const word = input.scopeTotal === 0 ? null : (input.statusFilter ?? TAB_WORD[input.tab] ?? null);
	const heading = `No ${word ? `${word} ` : ""}sessions ${where}`;
	const tabOrNot = input.scopeTotal === 0 ? "" : "tab, ";
	const body = input.ownerNarrowed
		? `Try another ${tabOrNot}owner or machine.`
		: input.scopeTotal === 0
			? "Try another machine."
			: "Try another tab or machine.";
	// Narrowed to one owner as well: widening to everyone is a way out too.
	const actions: EmptyState["actions"] = input.ownerNarrowed
		? ["allMachines", "viewEveryone"]
		: ["allMachines"];
	return { heading, body, actions };
}

/** Said (not shown) when a machine can't be expressed as a filter: the view is never silently widened. */
export const MACHINE_REFUSED_NOTE =
	"That machine's name can't be used as a filter, so the view was not changed.";
export const MACHINE_DROPPED_NOTE =
	"The saved machine filter couldn't be applied, so every machine is shown.";
