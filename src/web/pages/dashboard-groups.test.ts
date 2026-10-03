import { describe, expect, test } from "bun:test";
import type { OwnerStatsGroup } from "../../shared/types.js";
import {
	type DashboardGroup,
	type GroupHeader,
	type GroupableSession,
	groupByStorageKey,
	groupDashboardSessions,
	groupHeader,
	ownerGroupTotal,
	parseGroupBy,
} from "./dashboard-groups.js";
import { groupByProjectKey, groupSessionsStable } from "./dashboard-view-state.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";
const CASEY = "9a8b7c6d-1111-4222-8333-444455556666";
const ZED = "11111111-2222-4333-8444-555566667777";

const NAMES: Record<string, string> = {
	[ME]: "jay",
	[ALICE]: "Alice Smith",
	[CASEY]: "casey",
	[ZED]: "zed",
};
const ctx = { viewerUserId: ME, nameOf: (id: string) => NAMES[id] ?? `User ${id.slice(0, 4)}` };

interface Row extends GroupableSession {
	sessionId: string;
	status: string;
	isWorking: boolean;
	isArchived: boolean;
	endedAt: string | null;
	semanticStatus: string | null;
	lastAgentTurnCompletedAt: string | null;
	lastUserAcknowledgedAt: string | null;
}

function row(sessionId: string, over: Partial<Row> = {}): Row {
	return {
		sessionId,
		cwd: "/work/web-shop",
		agentType: "claude_code",
		isPinned: false,
		ownerUserId: ME,
		ownerKind: "user",
		status: "active",
		isWorking: false,
		isArchived: false,
		endedAt: null,
		semanticStatus: null,
		lastAgentTurnCompletedAt: null,
		lastUserAcknowledgedAt: null,
		...over,
	};
}

const fixture: Row[] = [
	row("a", { cwd: "/work/zeta", ownerUserId: ALICE }),
	row("b", { cwd: "/work/alpha", ownerUserId: ME }),
	row("c", { cwd: "/work/alpha", ownerUserId: CASEY, isPinned: true, agentType: "codex_cli" }),
	row("d", { cwd: null, ownerUserId: null, ownerKind: "service" }),
	row("e", { cwd: "/work/zeta", ownerUserId: null, ownerKind: "unassigned" }),
	row("f", { cwd: "/work/beta", ownerUserId: ZED, agentType: "copilot_cli" }),
];

describe("grouping by project", () => {
	test("is exactly what the dashboard has always done, on a fixture", () => {
		const legacy = groupSessionsStable(
			fixture,
			groupByProjectKey,
			(project) => project,
			(s) => s.isPinned,
		);
		const next = groupDashboardSessions(fixture, "project", ctx);
		expect(next.groups).toEqual(legacy);
		expect(next.flat).toBe(legacy.length <= 1);
	});

	test("pinned groups first, then by path; a session with no cwd is 'Unknown'", () => {
		const keys = groupDashboardSessions(fixture, "project", ctx).groups.map((g) => g.key);
		expect(keys).toEqual(["/work/alpha", "/work/beta", "/work/zeta", "Unknown"]);
	});

	test("one project is flat", () => {
		expect(groupDashboardSessions([row("x"), row("y")], "project", ctx).flat).toBe(true);
	});
});

describe("grouping by user", () => {
	test("you first, other people by name, then service keys, then unassigned", () => {
		const { groups } = groupDashboardSessions(fixture, "user", ctx);
		expect(groups.map((g) => g.key)).toEqual([ME, ALICE, CASEY, ZED, "service", "unassigned"]);
	});

	test("the order doesn't depend on who has urgent sessions or pinned cards", () => {
		const shuffled = [...fixture].reverse();
		const { groups } = groupDashboardSessions(shuffled, "user", ctx);
		expect(groups.map((g) => g.key)).toEqual([ME, ALICE, CASEY, ZED, "service", "unassigned"]);
	});

	test("names sort without regard to case, and a person with no name sorts by the fallback", () => {
		const rows = [
			row("1", { ownerUserId: "ccc00000-0000-4000-8000-000000000000" }),
			row("2", { ownerUserId: CASEY }),
			row("3", { ownerUserId: ALICE }),
		];
		const keys = groupDashboardSessions(rows, "user", { ...ctx, viewerUserId: null }).groups.map(
			(g) => g.key,
		);
		expect(keys).toEqual([ALICE, CASEY, "ccc00000-0000-4000-8000-000000000000"]);
	});

	test("labels: the name, and fixed words for the two ownerless kinds", () => {
		const { groups } = groupDashboardSessions(fixture, "user", ctx);
		expect(groups.map((g) => g.label)).toEqual([
			"jay",
			"Alice Smith",
			"casey",
			"zed",
			"Service keys",
			"Unassigned",
		]);
	});

	test("cards keep their order inside a group", () => {
		const rows = [
			row("p", { ownerUserId: ALICE }),
			row("q", { ownerUserId: ME }),
			row("r", { ownerUserId: ALICE }),
		];
		const alice = groupDashboardSessions(rows, "user", ctx).groups.find((g) => g.key === ALICE);
		expect(alice?.sessions.map((s) => s.sessionId)).toEqual(["p", "r"]);
	});

	test("a single owner still has its header", () => {
		expect(groupDashboardSessions([row("x"), row("y")], "user", ctx).flat).toBe(false);
	});
});

describe("grouping by agent", () => {
	test("by agent type, pinned first then by label", () => {
		const { groups } = groupDashboardSessions(fixture, "agent", ctx);
		expect(groups.map((g) => g.label)).toEqual(["Codex CLI", "Claude Code", "Copilot CLI"]);
		expect(groups.map((g) => g.key)).toEqual(["codex_cli", "claude_code", "copilot_cli"]);
	});

	test("one agent is flat", () => {
		expect(groupDashboardSessions([row("x"), row("y")], "agent", ctx).flat).toBe(true);
	});
});

describe("parseGroupBy", () => {
	test("reads the three words; anything else is the project grouping", () => {
		expect(parseGroupBy("user")).toBe("user");
		expect(parseGroupBy("agent")).toBe("agent");
		expect(parseGroupBy("project")).toBe("project");
		for (const bad of [null, "", "host", "None"]) expect(parseGroupBy(bad)).toBe("project");
	});
});

// ── headers ────────────────────────────────────────────────────────────────

function stats(over: Partial<OwnerStatsGroup> & { ownerUserId: string | null }): OwnerStatsGroup {
	return {
		ownerKind: over.ownerUserId ? "user" : "service",
		total: 0,
		active: 0,
		idle: 0,
		completed: 0,
		tabCounts: { active: 0, completed: 0, archived: 0 },
		working: 0,
		waiting: 0,
		error: 0,
		...over,
	};
}

const aliceStats = stats({
	ownerUserId: ALICE,
	total: 140,
	active: 30,
	completed: 100,
	tabCounts: { active: 30, completed: 100, archived: 10 },
	working: 3,
	waiting: 1,
	idle: 25,
	error: 1,
});

function headerCtx(over: Partial<Parameters<typeof groupHeader>[2]> = {}) {
	return {
		...ctx,
		teamHeaders: true,
		ownerStats: new Map([[ALICE, aliceStats]]),
		tab: "active",
		statusFilter: null,
		currentOwner: "all",
		...over,
	};
}

function userGroup(n: number, owner = ALICE): DashboardGroup<Row> {
	return {
		key: owner,
		label: NAMES[owner],
		sessions: Array.from({ length: n }, (_, i) => row(`s${i}`, { ownerUserId: owner })),
		pinned: false,
	};
}

describe("user group header", () => {
	test("name · shown of the server's count · working · waiting, with a way to see all of theirs", () => {
		const header = groupHeader(userGroup(22), "user", headerCtx({ tab: "all" }));
		// the All tab compares with the owner's non-archived sessions, which the All list pages through
		expect(header.title).toBe("Alice Smith");
		expect(header.countText).toBe("22 shown of 130");
		expect(header.showAll).toMatchObject({
			ownerId: ALICE,
			label: "Show all",
			ariaLabel: "Show all of Alice Smith's sessions",
		});
	});

	test("the owner's own working and waiting counts show only on the Active tab with no status card", () => {
		const active = groupHeader(userGroup(22), "user", headerCtx());
		expect(active.working).toBe(3);
		expect(active.waiting).toBe(1);
	});

	test("on any other tab, or under a status card, the chips come from the cards shown, never from the owner's active totals", () => {
		const shownCards: DashboardGroup<Row> = {
			key: ALICE,
			label: "Alice Smith",
			pinned: false,
			sessions: [row("w", { ownerUserId: ALICE, isWorking: true })],
		};
		for (const over of [
			{ tab: "all" },
			{ tab: "completed" },
			{ tab: "archived" },
			{ tab: "active", statusFilter: "waiting" as const },
			{ tab: "active", statusFilter: "working" as const },
		]) {
			const header = groupHeader(shownCards, "user", headerCtx(over));
			expect({ over, working: header.working, waiting: header.waiting }).toEqual({
				over,
				working: 1,
				waiting: 0,
			});
		}
	});

	test("on the Active tab 'of' is the owner's active count; on Completed, their completed count", () => {
		expect(groupHeader(userGroup(22), "user", headerCtx()).countText).toBe("22 shown of 30");
		expect(groupHeader(userGroup(22), "user", headerCtx({ tab: "completed" })).countText).toBe(
			"22 shown of 100",
		);
	});

	test("under a status card 'of' is the owner's count for that status", () => {
		const header = groupHeader(userGroup(1), "user", headerCtx({ statusFilter: "waiting" }));
		expect(header.countText).toBe("1 shown");
		const more = groupHeader(userGroup(2), "user", headerCtx({ statusFilter: "working" }));
		expect(more.countText).toBe("2 shown of 3");
	});

	test("no 'of' when everything is shown, and none before the counts arrive", () => {
		expect(groupHeader(userGroup(30), "user", headerCtx()).countText).toBe("30 shown");
		expect(groupHeader(userGroup(5), "user", headerCtx({ ownerStats: null })).countText).toBe(
			"5 shown",
		);
	});

	test("without server counts the chips are counted from the cards that are shown", () => {
		const group: DashboardGroup<Row> = {
			key: ALICE,
			label: "Alice Smith",
			pinned: false,
			sessions: [
				row("w", { ownerUserId: ALICE, isWorking: true }),
				row("x", { ownerUserId: ALICE, isWorking: true }),
				row("y", { ownerUserId: ALICE, lastAgentTurnCompletedAt: "2026-10-02T10:00:00Z" }),
			],
		};
		const header = groupHeader(group, "user", headerCtx({ ownerStats: null }));
		expect(header.working).toBe(2);
		expect(header.waiting).toBe(1);
	});

	test("you: '(you)' and 'yours'", () => {
		const mine = groupHeader(userGroup(4, ME), "user", headerCtx());
		expect(mine.title).toBe("jay (you)");
		expect(mine.showAll).toMatchObject({
			ownerId: ME,
			label: "Show all",
			ariaLabel: "Show all of your sessions",
		});
	});

	test("no 'show all' when the view is already that person's", () => {
		expect(
			groupHeader(userGroup(4), "user", headerCtx({ currentOwner: ALICE })).showAll,
		).toBeNull();
	});

	test("Service keys and Unassigned get 'Show all' like a person, unless the view is already theirs", () => {
		const ownerless = (key: string, label: string, kind: "service" | "unassigned") =>
			({
				key,
				label,
				pinned: false,
				sessions: [row("k", { ownerUserId: null, ownerKind: kind })],
			}) as DashboardGroup<Row>;
		const service = groupHeader(
			ownerless("service", "Service keys", "service"),
			"user",
			headerCtx(),
		);
		expect(service.title).toBe("Service keys");
		expect(service.showAll).toMatchObject({
			ownerId: "service",
			label: "Show all",
			ariaLabel: "Show all service-key sessions",
		});
		const unassigned = groupHeader(
			ownerless("unassigned", "Unassigned", "unassigned"),
			"user",
			headerCtx(),
		);
		expect(unassigned.showAll).toMatchObject({
			ownerId: "unassigned",
			ariaLabel: "Show all unassigned sessions",
		});
		expect(
			groupHeader(
				ownerless("service", "Service keys", "service"),
				"user",
				headerCtx({ currentOwner: "service" }),
			).showAll,
		).toBeNull();
	});

	test("the group-by choice is stored per person", () => {
		expect(groupByStorageKey("u-1")).toBe("agentpulse.dashboard.groupBy.u-1");
		expect(groupByStorageKey(null)).toBe("agentpulse.dashboard.groupBy.anonymous");
		expect(groupByStorageKey("u-1")).not.toBe(groupByStorageKey("u-2"));
	});
});

describe("project and agent headers", () => {
	const project: DashboardGroup<Row> = {
		key: "/work/web-shop",
		label: "/work/web-shop",
		pinned: false,
		sessions: [
			row("a"),
			row("b", { isWorking: true }),
			row("c", { lastAgentTurnCompletedAt: "2026-10-02T10:00:00Z" }),
		],
	};

	test("team: 'N shown', the path, and the chips counted from what is shown", () => {
		const header: GroupHeader = groupHeader(project, "project", headerCtx());
		expect(header.title).toBe("web-shop");
		expect(header.path).toBe("/work/web-shop");
		expect(header.countText).toBe("3 shown");
		expect(header.working).toBe(1);
		expect(header.waiting).toBe(1);
		expect(header.showAll).toBeNull();
	});

	test("solo keeps today's wording: 'N sessions', 'N session'", () => {
		expect(groupHeader(project, "project", headerCtx({ teamHeaders: false })).countText).toBe(
			"3 sessions",
		);
		const one = { ...project, sessions: [row("a")] };
		expect(groupHeader(one, "project", headerCtx({ teamHeaders: false })).countText).toBe(
			"1 session",
		);
	});

	test("agent: the agent's name as the title, no path", () => {
		const agent: DashboardGroup<Row> = {
			key: "codex_cli",
			label: "Codex CLI",
			pinned: false,
			sessions: [row("a")],
		};
		const header = groupHeader(agent, "agent", headerCtx());
		expect(header.title).toBe("Codex CLI");
		expect(header.path).toBeNull();
		expect(header.countText).toBe("1 shown");
	});
});

describe("ownerGroupTotal with the server's tab counts", () => {
	const withTabs = stats({
		ownerUserId: ALICE,
		total: 140,
		active: 12,
		completed: 100,
		tabCounts: { active: 30, completed: 100, archived: 10 },
		waiting: 1,
	});

	test("each tab's header count is that owner's size of the same tab the list shows", () => {
		expect(ownerGroupTotal(withTabs, "active", null)).toBe(30);
		expect(ownerGroupTotal(withTabs, "completed", null)).toBe(100);
		expect(ownerGroupTotal(withTabs, "archived", null)).toBe(10);
		expect(ownerGroupTotal(withTabs, "all", null)).toBe(130);
		expect(ownerGroupTotal(withTabs, "active", "waiting")).toBe(1);
	});

	test("a group from an older server falls back to the counts it has", () => {
		const { tabCounts: _gone, ...older } = withTabs;
		expect(ownerGroupTotal(older as never, "active", null)).toBe(12);
		expect(ownerGroupTotal(older as never, "archived", null)).toBeNull();
		expect(ownerGroupTotal(older as never, "all", null)).toBeNull();
	});
});

describe("ownerGroupTotal", () => {
	test("the count that matches the tab or the status card, or null where the server has none", () => {
		expect(ownerGroupTotal(aliceStats, "active", null)).toBe(30);
		expect(ownerGroupTotal(aliceStats, "completed", null)).toBe(100);
		expect(ownerGroupTotal(aliceStats, "active", "waiting")).toBe(1);
		expect(ownerGroupTotal(aliceStats, "active", "error")).toBe(1);
		expect(ownerGroupTotal(aliceStats, "all", null)).toBe(130);
		expect(ownerGroupTotal(aliceStats, "archived", null)).toBe(10);
	});
});
