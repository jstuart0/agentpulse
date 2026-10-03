import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN, type HostParam } from "../lib/host-scope.js";
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
