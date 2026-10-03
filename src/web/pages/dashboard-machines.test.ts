import { describe, expect, test } from "bun:test";
import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN } from "../lib/host-scope.js";
import {
	ALL_MACHINES_LABEL,
	UNKNOWN_MACHINE_LABEL,
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

const view = (over: Partial<Parameters<typeof machineOptions>[2]> = {}) => ({
	tab: "active",
	statusFilter: null,
	groupsTruncated: false,
	otherMachines: 0,
	...over,
});

function tabbed(
	host: string | null,
	counts: { active: number; completed: number; archived: number },
): HostStatsGroup {
	return {
		...group(host, counts.active + counts.completed + counts.archived),
		active: counts.active,
		completed: counts.completed,
		tabCounts: counts,
	};
}

describe("machineOptions", () => {
	test("every machine first, then each machine with its count in the tab on screen, the sessions with no machine reported last", () => {
		expect(machineOptions(twoAndNone, HOST_ALL, view())).toEqual([
			{ value: HOST_ALL, label: ALL_MACHINES_LABEL },
			{ value: "build-01", label: "build-01 (12)" },
			{ value: "edge-02", label: "edge-02 (3)" },
			{ value: HOST_UNKNOWN, label: `${UNKNOWN_MACHINE_LABEL} (2)` },
		]);
	});

	test("the counts follow the selected tab, so a machine with only archived sessions doesn't read as busy over an empty Active tab", () => {
		const groups = [
			tabbed("lonely-box", { active: 0, completed: 0, archived: 2 }),
			tabbed("busy-box", { active: 5, completed: 3, archived: 1 }),
		];
		const counts = (tab: string) =>
			machineOptions(groups, HOST_ALL, view({ tab }))
				.slice(1)
				.map((o) => o.label);
		expect(counts("active")).toEqual(["lonely-box (0)", "busy-box (5)"]);
		expect(counts("completed")).toEqual(["lonely-box (0)", "busy-box (3)"]);
		expect(counts("archived")).toEqual(["lonely-box (2)", "busy-box (1)"]);
		expect(counts("all")).toEqual(["lonely-box (0)", "busy-box (8)"]);
	});

	test("under a status card the count is that state's", () => {
		const waiting = { ...tabbed("build-01", { active: 4, completed: 0, archived: 0 }), waiting: 2 };
		expect(machineOptions([waiting], HOST_ALL, view({ statusFilter: "waiting" }))[1].label).toBe(
			"build-01 (2)",
		);
	});

	test("the sessions with no machine reported are offered only while some session has none", () => {
		expect(machineOptions(two, HOST_ALL, view()).map((o) => o.value)).toEqual([
			HOST_ALL,
			"build-01",
			"edge-02",
		]);
	});

	test("a chosen machine the server no longer lists is still offered, with a zero only when the list is complete", () => {
		expect(machineOptions(two, "retired-box", view()).map((o) => o.label)).toEqual([
			ALL_MACHINES_LABEL,
			"build-01 (12)",
			"edge-02 (3)",
			"retired-box (0)",
		]);
		expect(machineOptions(two, HOST_UNKNOWN, view()).at(-1)).toEqual({
			value: HOST_UNKNOWN,
			label: `${UNKNOWN_MACHINE_LABEL} (0)`,
		});
	});

	test("when the list was cut, a chosen machine outside it is shown without a count, and a disabled line says how many are not listed", () => {
		const options = machineOptions(
			two,
			"quiet-box",
			view({ groupsTruncated: true, otherMachines: 7 }),
		);
		expect(options.map((o) => o.label)).toEqual([
			ALL_MACHINES_LABEL,
			"build-01 (12)",
			"edge-02 (3)",
			"quiet-box",
			"7 more machines not listed",
		]);
		expect(options.at(-1)).toMatchObject({ disabled: true });
		expect(options.slice(0, -1).every((o) => !o.disabled)).toBe(true);
		const one = machineOptions(two, HOST_ALL, view({ groupsTruncated: true, otherMachines: 1 }));
		expect(one.at(-1)?.label).toBe("1 more machine not listed");
	});

	test("before the counts arrive only every machine and the current choice are offered, without counts", () => {
		expect(machineOptions(null, HOST_ALL, view()).map((o) => o.value)).toEqual([HOST_ALL]);
		expect(machineOptions(null, "build-01", view()).map((o) => o.label)).toEqual([
			ALL_MACHINES_LABEL,
			"build-01",
		]);
	});

	test("a name that looks like the reserved words is just a name", () => {
		const options = machineOptions(
			[group("unknown", 1), group("All machines", 1)],
			HOST_ALL,
			view(),
		);
		expect(options.map((o) => o.value)).toEqual([HOST_ALL, "unknown", "All machines"]);
	});
});

describe("machineControlVisible: no noise with one machine, and no flicker", () => {
	test("hidden with no machines, with one, or while nothing is known yet", () => {
		for (const machineCount of [0, 1, null]) {
			expect(machineControlVisible({ machineCount, host: HOST_ALL, groupBy: "project" })).toBe(
				false,
			);
		}
	});

	test("shown as soon as two machines are told apart, counting the sessions with no machine reported as one", () => {
		expect(machineControlVisible({ machineCount: 2, host: HOST_ALL, groupBy: "project" })).toBe(
			true,
		);
		expect(machineControlVisible({ machineCount: 40, host: HOST_ALL, groupBy: "project" })).toBe(
			true,
		);
	});

	test("kept while a machine is chosen or the cards are grouped by machine, so the way back is always there", () => {
		expect(machineControlVisible({ machineCount: 1, host: "build-01", groupBy: "project" })).toBe(
			true,
		);
		expect(
			machineControlVisible({ machineCount: null, host: HOST_UNKNOWN, groupBy: "project" }),
		).toBe(true);
		expect(machineControlVisible({ machineCount: 0, host: HOST_ALL, groupBy: "machine" })).toBe(
			true,
		);
	});
});

describe("waitingOnOtherMachines", () => {
	const w = (host: string | null, waiting: number): HostStatsGroup => ({
		...group(host, 5),
		waiting,
	});
	test("the waiting sessions on every machine but the chosen one", () => {
		const groups = [w("a", 2), w("b", 1), w(null, 4)];
		expect(waitingOnOtherMachines(groups, "a")).toBe(5);
		expect(waitingOnOtherMachines(groups, HOST_UNKNOWN)).toBe(3);
		expect(waitingOnOtherMachines(groups, "b")).toBe(6);
	});
	test("nothing to say with every machine chosen, or before the counts arrive", () => {
		expect(waitingOnOtherMachines([w("a", 2)], HOST_ALL)).toBe(0);
		expect(waitingOnOtherMachines(null, "a")).toBe(0);
	});
	test("a chosen machine the list doesn't hold leaves every listed machine as 'other'", () => {
		expect(waitingOnOtherMachines([w("a", 2)], "gone")).toBe(2);
	});
});

describe("machineScopeText", () => {
	test("names the machine and says what is waiting elsewhere", () => {
		expect(machineScopeText("build-01", 0, false)).toBe("Showing build-01 only.");
		expect(machineScopeText("build-01", 3, false)).toBe("Showing build-01 only. 3 waiting on other machines.");
	});

	test("the sessions with no machine reported read as a filter, not a machine called that", () => {
		expect(machineScopeText(HOST_UNKNOWN, 1, false)).toBe(
			"Showing only sessions with no machine reported. 1 waiting on other machines.",
		);
	});

	test("when the machine list was cut, the figure is a floor: some may be waiting on machines that aren't listed", () => {
		expect(machineScopeText("build-01", 18, true)).toBe(
			"Showing build-01 only. At least 18 waiting on other machines.",
		);
		expect(machineScopeText("build-01", 0, true)).toBe("Showing build-01 only.");
	});
});

describe("teamLineText: the team line under a machine filter says whose machine", () => {
	test("every machine is the team-wide wording it always was", () => {
		expect(teamLineText(4, HOST_ALL)).toBe("4 more active across the team.");
	});
	test("a machine is named, so a machine-scoped number doesn't read as team-wide", () => {
		expect(teamLineText(1, "build-01")).toBe("1 more active across the team on build-01.");
		expect(teamLineText(2, HOST_UNKNOWN)).toBe("2 more active across the team with no machine reported.");
	});
});

describe("hasUnlistedMachine: a pushed session on a machine the control doesn't know yet", () => {
	const groups = [group("build-01", 3)];
	test("a row on an unknown name, or with none while none is listed, is unlisted", () => {
		expect(hasUnlistedMachine([{ machine: "edge-02" }], groups)).toBe(true);
		expect(hasUnlistedMachine([{ machine: null }], groups)).toBe(true);
	});
	test("rows on listed machines, rows that don't say, and no groups yet are not", () => {
		expect(
			hasUnlistedMachine([{ machine: "build-01" }, { machine: " build-01 " }, {}], groups),
		).toBe(false);
		expect(hasUnlistedMachine([{ machine: null }], twoAndNone)).toBe(false);
		expect(hasUnlistedMachine([{ machine: "x" }], null)).toBe(false);
	});
});

describe("labels and announcements", () => {
	test("the sessions with no machine are called one thing", () => {
		expect(UNKNOWN_MACHINE_LABEL).toBe("No machine reported");
	});

	test("a machine is its name and unknown is a phrase", () => {
		expect(machineLabel("build-01")).toBe("build-01");
		expect(machineLabel(HOST_UNKNOWN)).toBe(UNKNOWN_MACHINE_LABEL);
		expect(machineLabel(HOST_ALL)).toBe(ALL_MACHINES_LABEL);
	});

	test("the live region says what the view became", () => {
		expect(machineAnnouncement(HOST_ALL)).toBe("Showing sessions on every machine.");
		expect(machineAnnouncement("build-01")).toBe("Showing sessions on build-01.");
		expect(machineAnnouncement(HOST_UNKNOWN)).toBe("Showing sessions with no machine reported.");
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
		expect(unknown?.heading).toBe("No active sessions with no machine reported");
		expect(unknown?.body).toBe("Try another tab, owner or machine.");
	});
});
