import { describe, expect, test } from "bun:test";
import { dashboardEmptyState, shouldShowFirstRun } from "./dashboard-empty.js";

const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";

const base = {
	kind: "mine" as const,
	owner: "me",
	ownerName: null,
	tab: "active",
	statusFilter: null,
	searchActive: false,
	ownerTotal: 0,
	othersActive: 0,
};

describe("dashboardEmptyState", () => {
	test("Mine, and the viewer owns nothing at all", () => {
		expect(dashboardEmptyState({ ...base, ownerTotal: 0, othersActive: 7 })).toEqual({
			heading: "No sessions from your keys yet",
			body: "Connect a machine with your own key and its sessions appear here.",
			actions: ["setup", "viewEveryone"],
		});
	});

	test("Mine, an empty tab, others active", () => {
		expect(dashboardEmptyState({ ...base, ownerTotal: 12, othersActive: 7 })).toEqual({
			heading: "None of your sessions are active",
			body: "7 active across the team.",
			actions: ["viewEveryone"],
		});
	});

	test("Mine, an empty tab, nobody else active either", () => {
		expect(dashboardEmptyState({ ...base, ownerTotal: 12, tab: "completed" })).toEqual({
			heading: "None of your sessions are completed",
			body: "Try another tab.",
			actions: [],
		});
	});

	test("Mine under a status card names the status", () => {
		expect(
			dashboardEmptyState({ ...base, ownerTotal: 12, statusFilter: "waiting", othersActive: 2 }),
		).toEqual({
			heading: "None of your sessions are waiting",
			body: "2 active across the team.",
			actions: ["viewEveryone"],
		});
	});

	test("a person with nothing on this tab", () => {
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: ALICE,
				ownerName: "Alice Smith",
				ownerTotal: 40,
			}),
		).toEqual({
			heading: "Alice Smith has no active sessions",
			body: "Try another tab or another owner.",
			actions: [],
		});
	});

	test("a person with no sessions at all", () => {
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: ALICE,
				ownerName: "Alice Smith",
				ownerTotal: 0,
			}),
		).toEqual({
			heading: "Alice Smith has no sessions",
			body: "Try another owner.",
			actions: [],
		});
	});

	test("Unassigned with nothing in it", () => {
		expect(
			dashboardEmptyState({ ...base, kind: "shared", owner: "unassigned", ownerTotal: 0 }),
		).toEqual({
			heading: "Every session has an owner",
			body: null,
			actions: [],
		});
	});

	test("Unassigned with sessions, just none on this tab", () => {
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: "unassigned",
				ownerTotal: 5,
				tab: "completed",
			})?.heading,
		).toBe("No completed unassigned sessions");
	});

	test("service keys", () => {
		expect(
			dashboardEmptyState({ ...base, kind: "shared", owner: "service", ownerTotal: 0 })?.heading,
		).toBe("No sessions from service keys");
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: "service",
				ownerTotal: 4,
				tab: "completed",
			})?.heading,
		).toBe("No completed sessions from service keys");
	});

	test("Unassigned names itself the same way", () => {
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: "unassigned",
				ownerTotal: 5,
				tab: "completed",
			})?.heading,
		).toBe("No completed unassigned sessions");
	});

	test("on a tab other than Active, Mine says 'Try another tab.' once and offers no second way out", () => {
		for (const tab of ["completed", "archived", "all"]) {
			expect(dashboardEmptyState({ ...base, ownerTotal: 12, tab, othersActive: 7 })).toEqual({
				heading: `None of your sessions are ${tab === "all" ? "in this view" : tab}`,
				body: "Try another tab.",
				actions: [],
			});
		}
	});

	test("a tab whose badge is above zero is never called empty", () => {
		expect(
			dashboardEmptyState({ ...base, ownerTotal: 12, tab: "archived", tabCount: 4 }),
		).toBeNull();
		expect(
			dashboardEmptyState({
				...base,
				kind: "shared",
				owner: ALICE,
				ownerName: "Alice Smith",
				ownerTotal: 40,
				tab: "completed",
				tabCount: 3,
			}),
		).toBeNull();
	});

	test("one person's help never says 'across the team'", () => {
		const state = dashboardEmptyState({
			...base,
			kind: "shared",
			owner: ALICE,
			ownerName: "Alice Smith",
			ownerTotal: 40,
		});
		expect(JSON.stringify(state)).not.toContain("team");
	});

	test("Everyone, solo and a search keep the grid's own empty copy", () => {
		expect(dashboardEmptyState({ ...base, kind: "shared", owner: "all" })).toBeNull();
		expect(dashboardEmptyState({ ...base, kind: "plain", owner: "all" })).toBeNull();
		expect(dashboardEmptyState({ ...base, searchActive: true })).toBeNull();
	});
});

describe("shouldShowFirstRun", () => {
	test("an empty install, once loaded", () => {
		expect(shouldShowFirstRun({ isLoading: false, loadedCount: 0, owner: "all" })).toBe(true);
	});

	test("never while loading, or when there is anything", () => {
		expect(shouldShowFirstRun({ isLoading: true, loadedCount: 0, owner: "all" })).toBe(false);
		expect(shouldShowFirstRun({ isLoading: false, loadedCount: 3, owner: "all" })).toBe(false);
	});

	test("a narrowed view that is empty keeps the page", () => {
		for (const owner of ["me", ALICE, "unassigned", "service"]) {
			expect(shouldShowFirstRun({ isLoading: false, loadedCount: 0, owner })).toBe(false);
		}
	});

	test("an install whose every session is scratch keeps the page, and the toggle that shows them", () => {
		const base = { isLoading: false, loadedCount: 0, owner: "all" };
		expect(shouldShowFirstRun({ ...base, stats: { total: 0, scratchHidden: 4 } })).toBe(false);
		expect(shouldShowFirstRun({ ...base, stats: { total: 5, scratchHidden: 0 } })).toBe(false);
	});

	test("the stats say there is nothing at all, or say nothing: first run", () => {
		const base = { isLoading: false, loadedCount: 0, owner: "all" };
		expect(shouldShowFirstRun({ ...base, stats: { total: 0, scratchHidden: 0 } })).toBe(true);
		expect(shouldShowFirstRun({ ...base, stats: null })).toBe(true);
		expect(shouldShowFirstRun({ ...base, stats: { total: 0 } })).toBe(true);
	});
});
