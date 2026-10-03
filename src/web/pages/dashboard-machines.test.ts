import { describe, expect, test } from "bun:test";
import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN } from "../lib/host-scope.js";
import {
	ALL_MACHINES_LABEL,
	UNKNOWN_MACHINE_LABEL,
	groupByOptions,
	machineAnnouncement,
	machineControlVisible,
	machineEmptyState,
	machineLabel,
	machineOptions,
	viewControlsVisible,
} from "./dashboard-machines.js";

function group(host: string | null, total: number): HostStatsGroup {
	return {
		host,
		total,
		active: total,
		idle: 0,
		completed: 0,
		tabCounts: { active: total, completed: 0, archived: 0 },
		working: 0,
		waiting: 0,
		error: 0,
	};
}

const two = [group("build-01", 12), group("edge-02", 3)];
const twoAndNone = [...two, group(null, 2)];

describe("machineOptions", () => {
	test("every machine first, then each machine with its count, the sessions with no machine last", () => {
		expect(machineOptions(twoAndNone, HOST_ALL)).toEqual([
			{ value: HOST_ALL, label: ALL_MACHINES_LABEL },
			{ value: "build-01", label: "build-01 (12)" },
			{ value: "edge-02", label: "edge-02 (3)" },
			{ value: HOST_UNKNOWN, label: `${UNKNOWN_MACHINE_LABEL} (2)` },
		]);
	});

	test("unknown is offered only while some session has no machine", () => {
		expect(machineOptions(two, HOST_ALL).map((o) => o.value)).toEqual([
			HOST_ALL,
			"build-01",
			"edge-02",
		]);
	});

	test("a chosen machine the server no longer lists is still offered, so the select never shows something it isn't", () => {
		expect(machineOptions(two, "retired-box").map((o) => o.value)).toEqual([
			HOST_ALL,
			"build-01",
			"edge-02",
			"retired-box",
		]);
		expect(machineOptions(two, HOST_UNKNOWN).at(-1)).toEqual({
			value: HOST_UNKNOWN,
			label: `${UNKNOWN_MACHINE_LABEL} (0)`,
		});
	});

	test("before the counts arrive only every machine, and the current choice, are offered", () => {
		expect(machineOptions(null, HOST_ALL).map((o) => o.value)).toEqual([HOST_ALL]);
		expect(machineOptions(null, "build-01").map((o) => o.value)).toEqual([HOST_ALL, "build-01"]);
	});

	test("a name that looks like the reserved words is just a name", () => {
		const options = machineOptions([group("unknown", 1), group("All machines", 1)], HOST_ALL);
		expect(options.map((o) => o.value)).toEqual([HOST_ALL, "unknown", "All machines"]);
	});
});

describe("machineControlVisible: no noise with one machine", () => {
	test("hidden with no machines, with one, or while the counts are not in", () => {
		expect(machineControlVisible({ groups: [], host: HOST_ALL, groupBy: "project" })).toBe(false);
		expect(
			machineControlVisible({ groups: [group("build-01", 5)], host: HOST_ALL, groupBy: "project" }),
		).toBe(false);
		expect(
			machineControlVisible({ groups: [group(null, 5)], host: HOST_ALL, groupBy: "project" }),
		).toBe(false);
		expect(machineControlVisible({ groups: null, host: HOST_ALL, groupBy: "project" })).toBe(false);
	});

	test("shown as soon as two machines are told apart, with or without sessions that have none", () => {
		expect(machineControlVisible({ groups: two, host: HOST_ALL, groupBy: "project" })).toBe(true);
		expect(
			machineControlVisible({
				groups: [group("build-01", 5), group(null, 1)],
				host: HOST_ALL,
				groupBy: "project",
			}),
		).toBe(true);
	});

	test("kept while a machine is chosen or the cards are grouped by machine, so the way back is always there", () => {
		expect(
			machineControlVisible({
				groups: [group("build-01", 5)],
				host: "build-01",
				groupBy: "project",
			}),
		).toBe(true);
		expect(machineControlVisible({ groups: null, host: HOST_UNKNOWN, groupBy: "project" })).toBe(
			true,
		);
		expect(machineControlVisible({ groups: [], host: HOST_ALL, groupBy: "machine" })).toBe(true);
	});
});

describe("labels and announcements", () => {
	test("a machine is its name and unknown is a phrase", () => {
		expect(machineLabel("build-01")).toBe("build-01");
		expect(machineLabel(HOST_UNKNOWN)).toBe(UNKNOWN_MACHINE_LABEL);
		expect(machineLabel(HOST_ALL)).toBe(ALL_MACHINES_LABEL);
	});

	test("the live region says what the view became", () => {
		expect(machineAnnouncement(HOST_ALL)).toBe("Showing sessions on every machine.");
		expect(machineAnnouncement("build-01")).toBe("Showing sessions on build-01.");
		expect(machineAnnouncement(HOST_UNKNOWN)).toBe("Showing sessions with no machine.");
	});
});

describe("groupByOptions", () => {
	test("a team: project, user, agent, and machine once machines can be told apart", () => {
		expect(groupByOptions({ team: true, machineControl: false })).toEqual([
			"project",
			"user",
			"agent",
		]);
		expect(groupByOptions({ team: true, machineControl: true })).toEqual([
			"project",
			"user",
			"agent",
			"machine",
		]);
	});

	test("solo has no users to group by: project, machine, agent", () => {
		expect(groupByOptions({ team: false, machineControl: true })).toEqual([
			"project",
			"machine",
			"agent",
		]);
		expect(groupByOptions({ team: false, machineControl: false })).toEqual(["project", "agent"]);
	});
});

describe("viewControlsVisible: solo keeps its page unless there is something to choose", () => {
	test("a team always has Group by", () => {
		expect(viewControlsVisible({ team: true, machineControl: false, groupBy: "project" })).toBe(
			true,
		);
	});

	test("solo shows them with two machines, or while a grouping other than project is on, so it can always be undone", () => {
		expect(viewControlsVisible({ team: false, machineControl: false, groupBy: "project" })).toBe(
			false,
		);
		expect(viewControlsVisible({ team: false, machineControl: true, groupBy: "project" })).toBe(
			true,
		);
		expect(viewControlsVisible({ team: false, machineControl: false, groupBy: "agent" })).toBe(
			true,
		);
		expect(viewControlsVisible({ team: false, machineControl: false, groupBy: "machine" })).toBe(
			true,
		);
	});
});

describe("machineEmptyState", () => {
	const base = {
		host: "build-01",
		tab: "active",
		statusFilter: null,
		searchActive: false,
		scopeTotal: 0,
		tabCount: 0,
		ownerNarrowed: false,
	} as const;

	test("no machine chosen, a search, or a tab whose badge says there is something: the grid's own copy", () => {
		expect(machineEmptyState({ ...base, host: HOST_ALL })).toBeNull();
		expect(machineEmptyState({ ...base, searchActive: true })).toBeNull();
		expect(machineEmptyState({ ...base, tabCount: 3, scopeTotal: 3 })).toBeNull();
	});

	test("a machine with nothing at all says so and offers the way back", () => {
		expect(machineEmptyState(base)).toEqual({
			heading: "No sessions on build-01",
			body: "Try another machine.",
			actions: ["allMachines"],
		});
	});

	test("a machine with sessions, none in this tab or state, names the filter", () => {
		expect(machineEmptyState({ ...base, scopeTotal: 9 })).toEqual({
			heading: "No active sessions on build-01",
			body: "Try another tab or machine.",
			actions: ["allMachines"],
		});
		expect(machineEmptyState({ ...base, scopeTotal: 9, statusFilter: "waiting" })?.heading).toBe(
			"No waiting sessions on build-01",
		);
		expect(machineEmptyState({ ...base, scopeTotal: 9, tab: "all" })?.heading).toBe(
			"No sessions on build-01",
		);
	});

	test("when whose sessions is narrowed too, the way out includes everyone's, and the body says owner as well", () => {
		const empty = machineEmptyState({ ...base, ownerNarrowed: true });
		expect(empty).toEqual({
			heading: "No sessions on build-01",
			body: "Try another owner or machine.",
			actions: ["allMachines", "viewEveryone"],
		});
		expect(machineEmptyState({ ...base, scopeTotal: 9, ownerNarrowed: true })?.actions).toEqual([
			"allMachines",
			"viewEveryone",
		]);
		expect(machineEmptyState({ ...base, scopeTotal: 9 })?.actions).toEqual(["allMachines"]);
	});

	test("unknown reads as no machine, and a narrowed owner is mentioned in the way out", () => {
		const unknown = machineEmptyState({
			...base,
			host: HOST_UNKNOWN,
			scopeTotal: 9,
			ownerNarrowed: true,
		});
		expect(unknown?.heading).toBe("No active sessions with no machine");
		expect(unknown?.body).toBe("Try another tab, owner or machine.");
	});
});
