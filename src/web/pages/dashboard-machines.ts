import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN, type HostParam } from "../lib/host-scope.js";
import type { EmptyState } from "./dashboard-empty.js";
import type { GroupBy } from "./dashboard-groups.js";

/**
 * What the Machine filter offers, when it shows at all, and what the page says
 * about it. Pure: components read the answers. A machine is where a session
 * runs as the dashboard shows it (the supervisor's host, else the name a relay
 * reported, else none); the choice narrows the view and decides nothing about
 * who may see or change a session.
 */
export const ALL_MACHINES_LABEL = "All machines";
export const UNKNOWN_MACHINE_LABEL = "Unknown machine";

export interface MachineOption {
	value: HostParam;
	label: string;
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
 * with how many sessions it has in this view, then the sessions with no machine
 * while there are any. A chosen machine the server doesn't list is still offered,
 * so the select never shows something it isn't. Before the counts arrive only
 * every machine and the current choice are offered, without counts.
 */
export function machineOptions(
	groups: readonly HostStatsGroup[] | null,
	current: HostParam,
): MachineOption[] {
	const options: MachineOption[] = [{ value: HOST_ALL, label: ALL_MACHINES_LABEL }];
	const counted = (host: string | null) => groups?.find((g) => g.host === host)?.total ?? null;
	const named = (groups ?? []).filter((g) => g.host !== null) as Array<
		HostStatsGroup & { host: string }
	>;
	for (const g of named) options.push({ value: g.host, label: withCount(g.host, g.total) });
	if (current !== HOST_ALL && current !== HOST_UNKNOWN && !named.some((g) => g.host === current)) {
		options.push({ value: current, label: withCount(current, groups === null ? null : 0) });
	}
	if (counted(null) !== null || current === HOST_UNKNOWN) {
		options.push({
			value: HOST_UNKNOWN,
			label: withCount(UNKNOWN_MACHINE_LABEL, groups === null ? null : (counted(null) ?? 0)),
		});
	}
	return options;
}

/**
 * Whether the control is drawn. With one machine (or none reported) there is
 * nothing to tell apart, so the page stays as it was; as soon as two groups
 * exist it appears. It stays while a machine is chosen or the cards are grouped
 * by machine, so the way back is never taken away by a count that dropped.
 */
export function machineControlVisible(input: {
	groups: readonly HostStatsGroup[] | null;
	host: HostParam;
	groupBy: GroupBy;
}): boolean {
	if (input.host !== HOST_ALL || input.groupBy === "machine") return true;
	return input.groups !== null && input.groups.length > 1;
}

export function machineAnnouncement(host: HostParam): string {
	if (host === HOST_ALL) return "Showing sessions on every machine.";
	if (host === HOST_UNKNOWN) return "Showing sessions with no machine.";
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
	const where = input.host === HOST_UNKNOWN ? "with no machine" : `on ${input.host}`;
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
