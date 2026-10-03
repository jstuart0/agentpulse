import { describe, expect, test } from "bun:test";
import type { HostStatsGroup, OwnerStatsGroup } from "../../shared/types.js";
import {
	type DashboardGroup,
	type GroupHeader,
	type GroupableSession,
	groupByStorageKey,
	groupDashboardSessions,
	groupHeader,
	hostStatsByKey,
	machineKeysWithSessions,
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
	test("reads the four words; anything else is the project grouping", () => {
		expect(parseGroupBy("user")).toBe("user");
		expect(parseGroupBy("agent")).toBe("agent");
		expect(parseGroupBy("machine")).toBe("machine");
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

// ── machines ───────────────────────────────────────────────────────────────

const HOST_UNKNOWN_KEY = "\u001funknown";

describe("grouping by machine", () => {
	const onMachines: Row[] = [
		row("1", { machine: "edge-02" }),
		row("2", { machine: "Build-01" }),
		row("3", { machine: null }),
		row("4", { machine: "build-01" }),
		row("5", { machine: "  edge-02 ", isPinned: true }),
		row("6", { machine: "" }),
		row("7", {}),
		row("8", { machine: "alice-mbp" }),
	];

	test("by name without regard to case (the server's own order, ties by spelling), the sessions with no machine last, and a pinned card doesn't move its group", () => {
		const { groups } = groupDashboardSessions(onMachines, "machine", ctx);
		expect(groups.map((g) => g.key)).toEqual([
			"alice-mbp",
			"Build-01",
			"build-01",
			"edge-02",
			HOST_UNKNOWN_KEY,
		]);
	});

	test("a name is its own group: padding is the same machine, case is another", () => {
		const { groups } = groupDashboardSessions(onMachines, "machine", ctx);
		expect(groups.find((g) => g.key === "edge-02")?.sessions.map((s) => s.sessionId)).toEqual([
			"1",
			"5",
		]);
	});

	test("null, blank and a row that says nothing are one group, labelled for people", () => {
		const unknown = groupDashboardSessions(onMachines, "machine", ctx).groups.find(
			(g) => g.key === HOST_UNKNOWN_KEY,
		);
		expect(unknown?.sessions.map((s) => s.sessionId)).toEqual(["3", "6", "7"]);
		expect(unknown?.label).toBe("No machine reported");
	});

	test("a header for every machine the server counted, with cards filling in as pages load", () => {
		const loaded = [row("1", { machine: "edge-02" })];
		const { groups } = groupDashboardSessions(loaded, "machine", ctx, {
			machineKeys: ["build-01", "edge-02", "studio-mac", HOST_UNKNOWN_KEY],
		});
		expect(groups.map((g) => [g.key, g.sessions.length])).toEqual([
			["build-01", 0],
			["edge-02", 1],
			["studio-mac", 0],
			[HOST_UNKNOWN_KEY, 0],
		]);
		expect(groups.at(-1)?.label).toBe("No machine reported");
	});

	test("a loaded row on a machine the server didn't list still gets its group, in name order", () => {
		const { groups } = groupDashboardSessions([row("1", { machine: "aaa" })], "machine", ctx, {
			machineKeys: ["build-01"],
		});
		expect(groups.map((g) => g.key)).toEqual(["aaa", "build-01"]);
	});

	test("one machine is flat; none at all is flat", () => {
		expect(
			groupDashboardSessions(
				[row("a", { machine: "x" }), row("b", { machine: "x" })],
				"machine",
				ctx,
			).flat,
		).toBe(true);
		expect(
			groupDashboardSessions([row("a"), row("b", { machine: null })], "machine", ctx).flat,
		).toBe(true);
		expect(
			groupDashboardSessions([row("a", { machine: "x" }), row("b")], "machine", ctx).flat,
		).toBe(false);
	});
});

function hostStats(over: Partial<HostStatsGroup> & { host: string | null }): HostStatsGroup {
	return {
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

const buildStats = hostStats({
	host: "build-01",
	total: 140,
	active: 30,
	completed: 100,
	tabCounts: { active: 30, completed: 100, archived: 10 },
	working: 3,
	waiting: 1,
	idle: 25,
	error: 1,
});

function machineGroup(n: number, key = "build-01"): DashboardGroup<Row> {
	return {
		key,
		label: key === HOST_UNKNOWN_KEY ? "No machine reported" : key,
		sessions: Array.from({ length: n }, (_, i) => row(`m${i}`, { machine: key })),
		pinned: false,
	};
}

function machineCtx(over: Partial<Parameters<typeof groupHeader>[2]> = {}) {
	return {
		...headerCtx(),
		machineStats: new Map([["build-01", buildStats]]),
		currentHost: "",
		...over,
	};
}

describe("hostStatsByKey", () => {
	test("keys the server's groups the way the groups are keyed, no machine under the reserved token", () => {
		const map = hostStatsByKey([buildStats, hostStats({ host: null, total: 2 })]);
		expect([...map.keys()]).toEqual(["build-01", HOST_UNKNOWN_KEY]);
	});
});

describe("machine group header", () => {
	test("name · shown of the server's count, with a way to see all of that machine", () => {
		const header = groupHeader(machineGroup(22), "machine", machineCtx({ tab: "all" }));
		expect(header.title).toBe("build-01");
		expect(header.path).toBeNull();
		expect(header.countText).toBe("22 shown of 130");
		expect(header.showAllHost).toEqual({
			host: "build-01",
			label: "Show all",
			ariaLabel: "Show all sessions on build-01",
		});
		expect(header.showAll).toBeNull();
	});

	test("the machine's own working and waiting counts show only on the Active tab with no status card", () => {
		const active = groupHeader(machineGroup(22), "machine", machineCtx());
		expect([active.working, active.waiting]).toEqual([3, 1]);
		const completed = groupHeader(machineGroup(22), "machine", machineCtx({ tab: "completed" }));
		expect([completed.working, completed.waiting]).toEqual([0, 0]);
		const card = groupHeader(machineGroup(22), "machine", machineCtx({ statusFilter: "waiting" }));
		expect([card.working, card.waiting]).toEqual([0, 0]);
	});

	test("nothing more to show, a search, or already filtered to it: no 'Show all'", () => {
		expect(groupHeader(machineGroup(30), "machine", machineCtx()).showAllHost).toBeNull();
		expect(
			groupHeader(machineGroup(22), "machine", machineCtx({ searchActive: true })).showAllHost,
		).toBeNull();
		expect(
			groupHeader(machineGroup(22), "machine", machineCtx({ currentHost: "build-01" })).showAllHost,
		).toBeNull();
	});

	test("searching counts matches, as the owner headers do", () => {
		const header = groupHeader(machineGroup(4), "machine", machineCtx({ searchActive: true }));
		expect(header.countText).toBe("4 matching");
	});

	test("the sessions with no machine say so, and 'Show all' selects the reserved value", () => {
		const unknownStats = hostStats({
			host: null,
			total: 9,
			active: 9,
			tabCounts: { active: 9, completed: 0, archived: 0 },
		});
		const header = groupHeader(
			machineGroup(3, HOST_UNKNOWN_KEY),
			"machine",
			machineCtx({ machineStats: new Map([[HOST_UNKNOWN_KEY, unknownStats]]) }),
		);
		expect(header.title).toBe("No machine reported");
		expect(header.countText).toBe("3 shown of 9");
		expect(header.showAllHost).toEqual({
			host: HOST_UNKNOWN_KEY,
			label: "Show all",
			ariaLabel: "Show all sessions with no machine reported",
		});
	});

	test("before the server's counts arrive, solo says 'N sessions' and a team says 'N shown'", () => {
		const none = machineCtx({ machineStats: null });
		expect(groupHeader(machineGroup(2), "machine", { ...none, teamHeaders: false }).countText).toBe(
			"2 sessions",
		);
		expect(groupHeader(machineGroup(1), "machine", { ...none, teamHeaders: false }).countText).toBe(
			"1 session",
		);
		expect(groupHeader(machineGroup(2), "machine", none).countText).toBe("2 shown");
		expect(groupHeader(machineGroup(2), "machine", none).showAllHost).toBeNull();
	});
});

describe("machineKeysWithSessions", () => {
	const mk = (host: string | null, tabs: { active: number; completed: number; archived: number }) =>
		hostStats({
			host,
			total: tabs.active + tabs.completed + tabs.archived,
			tabCounts: tabs,
			active: tabs.active,
			completed: tabs.completed,
		});
	const groups = [
		mk("busy", { active: 3, completed: 1, archived: 0 }),
		mk("old-box", { active: 0, completed: 2, archived: 1 }),
		mk(null, { active: 1, completed: 0, archived: 0 }),
	];

	test("a machine gets a header on a tab only if it has sessions there", () => {
		expect(machineKeysWithSessions(groups, "active", null)).toEqual(["busy", HOST_UNKNOWN_KEY]);
		expect(machineKeysWithSessions(groups, "completed", null)).toEqual(["busy", "old-box"]);
		expect(machineKeysWithSessions(groups, "archived", null)).toEqual(["old-box"]);
		expect(machineKeysWithSessions(groups, "all", null)).toEqual([
			"busy",
			"old-box",
			HOST_UNKNOWN_KEY,
		]);
	});

	test("under a status card, the machines with sessions in that state", () => {
		const waiting = [
			{ ...mk("a", { active: 2, completed: 0, archived: 0 }), waiting: 1 },
			mk("b", { active: 2, completed: 0, archived: 0 }),
		];
		expect(machineKeysWithSessions(waiting, "active", "waiting")).toEqual(["a"]);
	});

	test("nothing before the counts arrive", () => {
		expect(machineKeysWithSessions(null, "active", null)).toEqual([]);
	});
});

describe("a machine header with no cards loaded yet", () => {
	test("says how many there are and still offers 'Show all'", () => {
		const empty: DashboardGroup<Row> = {
			key: "build-01",
			label: "build-01",
			sessions: [],
			pinned: false,
		};
		const header = groupHeader(empty, "machine", machineCtx({ tab: "all" }));
		expect(header.countText).toBe("0 shown of 130");
		expect(header.showAllHost?.host).toBe("build-01");
	});
});
