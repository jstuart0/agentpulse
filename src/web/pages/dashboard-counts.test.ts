import { describe, expect, test } from "bun:test";
import {
	COUNT_PLACEHOLDER,
	type StatsWithTabs,
	displayCount,
	expectedListTotal,
	liveStripText,
	tabBadgeCount,
	tabHint,
} from "./dashboard-counts.js";

function stats(over: Partial<StatsWithTabs> = {}): StatsWithTabs {
	return {
		ownerScope: { kind: "all" },
		total: 40,
		scratchHidden: 0,
		activeSessions: 9,
		totalSessionsToday: 0,
		totalToolUsesToday: 0,
		byAgentType: {} as never,
		operational: { waiting: 2, working: 4, idle: 1, error: 2 },
		truncated: false,
		completedCount: 20,
		archivedCount: 11,
		...over,
	} as StatsWithTabs;
}

describe("a count that has not arrived is a dash, never a zero", () => {
	test("absent counts show the placeholder; a real zero shows 0", () => {
		expect(displayCount(undefined)).toBe(COUNT_PLACEHOLDER);
		expect(displayCount(null)).toBe(COUNT_PLACEHOLDER);
		expect(displayCount(0)).toBe(0);
		expect(displayCount(12)).toBe(12);
		expect(COUNT_PLACEHOLDER).toBe("–");
	});
});

describe("tab badges", () => {
	test("come from the server's tab counts when it sends them", () => {
		const s = stats({ tabCounts: { active: 7, completed: 22, archived: 11 } });
		expect(tabBadgeCount("active", s, null)).toBe(7);
		expect(tabBadgeCount("completed", s, null)).toBe(22);
		expect(tabBadgeCount("archived", s, null)).toBe(11);
	});

	test("an older server falls back to the numbers the page always used", () => {
		const s = stats();
		expect(tabBadgeCount("active", s, null)).toBe(9);
		expect(tabBadgeCount("completed", s, null)).toBe(20);
		expect(tabBadgeCount("archived", s, null)).toBe(11);
	});

	test("All is everything the scope has except archived; a selected status card narrows the Active badge to its own count", () => {
		const s = stats({ tabCounts: { active: 7, completed: 22, archived: 11 } });
		expect(tabBadgeCount("all", s, null)).toBe(29);
		expect(tabBadgeCount("active", s, "working")).toBe(4);
	});

	test("before the stats arrive there is no badge", () => {
		expect(tabBadgeCount("active", null, null)).toBeUndefined();
		expect(tabBadgeCount("all", null, null)).toBeUndefined();
	});
});

describe("the total a loaded list should end up with", () => {
	test("a status list follows its card, a tab list follows its badge, All follows the scope's total", () => {
		const s = stats({ tabCounts: { active: 7, completed: 22, archived: 11 } });
		expect(expectedListTotal({ tab: "active", status: "waiting", stats: s })).toBe(2);
		expect(expectedListTotal({ tab: "active", status: null, stats: s })).toBe(7);
		expect(expectedListTotal({ tab: "completed", status: null, stats: s })).toBe(22);
		expect(expectedListTotal({ tab: "archived", status: null, stats: s })).toBe(11);
		expect(expectedListTotal({ tab: "all", status: null, stats: s })).toBe(40);
	});

	test("unknown until the stats arrive", () => {
		expect(expectedListTotal({ tab: "active", status: null, stats: null })).toBeUndefined();
	});

	test("expects nothing while a search is active: the counts describe the unsearched list", () => {
		const s = stats({ tabCounts: { active: 7, completed: 22, archived: 11 } });
		for (const tab of ["active", "completed", "archived", "all"]) {
			expect(
				expectedListTotal({ tab, status: null, stats: s, searching: true }),
				tab,
			).toBeUndefined();
		}
		expect(
			expectedListTotal({ tab: "active", status: "waiting", stats: s, searching: true }),
		).toBeUndefined();
		// Positive control: the same call without a search expects a number.
		expect(expectedListTotal({ tab: "active", status: null, stats: s, searching: false })).toBe(7);
	});
});

describe("the Live Sessions strip's numbers", () => {
	const base = { ready: true, shown: 12, activeTotal: 12, working: 5, attention: 3 };

	test("before the counts have arrived it shows dashes, never zeros", () => {
		expect(
			liveStripText({ ...base, ready: false, activeTotal: 0, working: 0, attention: 0 }),
		).toEqual({
			count: "– active",
			working: "– working",
			attention: null,
		});
	});

	test("with every active session shown it says how many are active, how many working and how many need a person", () => {
		expect(liveStripText(base)).toEqual({
			count: "12 active",
			working: "5 working",
			attention: "3 waiting or error",
		});
	});

	test("when the strip holds fewer than the scope has, it says so", () => {
		expect(liveStripText({ ...base, shown: 7, activeTotal: 40 }).count).toBe(
			"showing the 7 most recent of 40 active",
		);
	});

	test("nothing needing a person says nothing about it", () => {
		expect(liveStripText({ ...base, attention: 0 }).attention).toBeNull();
	});
});

describe("tabHint", () => {
	test("All says it leaves archived sessions out; the other tabs say nothing", () => {
		expect(tabHint("all")).toBe("Everything except archived sessions.");
		for (const tab of ["active", "completed", "archived"]) expect(tabHint(tab)).toBeNull();
	});

	test("the dashboard shows the hint under the tabs and on the tab itself", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const page = readFileSync(join(import.meta.dir, "DashboardPage.tsx"), "utf8");
		expect(page.match(/tabHint\(/g)?.length).toBeGreaterThanOrEqual(2);
	});
});
