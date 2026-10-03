import { describe, expect, test } from "bun:test";
import type { HostStatsGroup } from "../../shared/types.js";
import { HOST_ALL, HOST_UNKNOWN } from "../lib/host-scope.js";
import {
	ALL_MACHINES_LABEL,
	UNKNOWN_MACHINE_LABEL,
	machineAnnouncement,
	machineControlVisible,
	machineLabel,
	machineOptions,
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
