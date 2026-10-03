/**
 * The `tab` list filter selects exactly the sessions the matching stats count
 * describes: Active (activeSessions), Completed (completedCount), Archived
 * (archivedCount), under every owner scope and with scratch shown or hidden.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { projects, sessions } = await import("../db/schema/index.js");
const { getSessions, getSessionSummaries, getStats, getStatsByOwner } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const ALICE = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const BOB = "9a1c2d3e-4f5a-4b6f-8a7e-0c1d2e3f4a5b";
const TABS = ["active", "completed", "archived"] as const;
type Tab = (typeof TABS)[number];
type TabCounts = Record<Tab, number>;
const tabCountsOf = (stats: { tabCounts: TabCounts }) => stats.tabCounts;

const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

/**
 * One session per kind of row the tabs tell apart, and the one tab each belongs
 * to. `legacyActive` is whether the poll's older activeSessions card still
 * counts it (status = 'active'), which the tab redefinition must not change.
 */
const KINDS: Array<{
	kind: string;
	tab: Tab;
	legacyActive: boolean;
	row: Record<string, unknown>;
}> = [
	{ kind: "active", tab: "active", legacyActive: true, row: { status: "active" } },
	{
		kind: "working",
		tab: "active",
		legacyActive: true,
		row: { status: "active", isWorking: true },
	},
	{
		kind: "active-but-ended",
		tab: "completed",
		legacyActive: true,
		row: { status: "active", endedAt: iso(HOUR) },
	},
	{ kind: "idle-status", tab: "active", legacyActive: false, row: { status: "idle" } },
	{
		kind: "completed",
		tab: "completed",
		legacyActive: false,
		row: { status: "completed", endedAt: iso(HOUR) },
	},
	{
		kind: "legacy-archived-status",
		tab: "completed",
		legacyActive: false,
		row: { status: "archived" },
	},
	{
		kind: "archived-flag",
		tab: "archived",
		legacyActive: false,
		row: { status: "completed", endedAt: iso(HOUR), isArchived: true },
	},
	{
		kind: "active-archived-flag",
		tab: "archived",
		legacyActive: true,
		row: { status: "active", isArchived: true },
	},
	{
		kind: "failed-open",
		tab: "active",
		legacyActive: false,
		row: { status: "failed", endedAt: iso(2 * HOUR) },
	},
	{
		kind: "failed-dismissed",
		tab: "completed",
		legacyActive: false,
		row: { status: "failed", endedAt: iso(2 * HOUR), lastUserAcknowledgedAt: iso(HOUR) },
	},
	// A failure that was acknowledged but has no end time: the finished test is
	// unknown, and an unknown row must still land in a tab.
	{
		kind: "failed-acknowledged-without-end-time",
		tab: "active",
		legacyActive: false,
		row: { status: "failed", lastUserAcknowledgedAt: iso(HOUR) },
	},
	// The SQL only trusts a dismissal when both timestamps are in the shape the
	// app writes; bare timestamps can't be proven to order correctly, so the row
	// stays in Active (the dashboard's own classifier may know better).
	{
		kind: "failed-dismissed-bare-timestamps",
		tab: "active",
		legacyActive: false,
		row: {
			status: "failed",
			endedAt: "2026-01-01 10:00:00",
			lastUserAcknowledgedAt: "2026-01-01 11:00:00",
		},
	},
];

const OWNERS = [
	{ label: "all", scope: undefined, owns: () => true },
	{
		label: "alice",
		scope: { kind: "user", userId: ALICE } as const,
		owns: (r: Seeded) => r.ownerUserId === ALICE,
	},
	{
		label: "bob",
		scope: { kind: "user", userId: BOB } as const,
		owns: (r: Seeded) => r.ownerUserId === BOB,
	},
	{
		label: "unassigned",
		scope: { kind: "unassigned" } as const,
		owns: (r: Seeded) => !r.ownerUserId && !r.ingestKeyId,
	},
	{
		label: "service",
		scope: { kind: "service" } as const,
		owns: (r: Seeded) => !r.ownerUserId && !!r.ingestKeyId,
	},
];

interface Seeded {
	sessionId: string;
	ownerUserId: string | null;
	ingestKeyId: string | null;
	projectId: string | null;
	tab: Tab;
	legacyActive: boolean;
	lastActivityAt: string;
}

let seeded: Seeded[] = [];

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb().delete(projects).execute();
	await getDb()
		.insert(projects)
		.values([
			{ id: "p-scratch", name: "scratch-area", cwd: "/scratch", tags: ["scratch"] },
			{ id: "p-real", name: "real-area", cwd: "/real", tags: [] },
		])
		.execute();
	const ownerships: Array<[string | null, string | null]> = [
		[ALICE, null],
		[BOB, "key-b"],
		[null, null],
		[null, "key-svc"],
		[ALICE, "key-a"],
	];
	seeded = [];
	let n = 0;
	for (const [ownerUserId, ingestKeyId] of ownerships) {
		for (const projectId of ["p-scratch", "p-real", null]) {
			for (const { kind, tab, legacyActive, row } of KINDS) {
				n += 1;
				seeded.push({
					sessionId: `s-${n}-${kind}`,
					ownerUserId,
					ingestKeyId,
					projectId,
					tab,
					legacyActive,
					lastActivityAt: new Date(Date.now() - n * 1000).toISOString(),
				});
				await getDb()
					.insert(sessions)
					.values({
						sessionId: `s-${n}-${kind}`,
						displayName: `s-${n}`,
						agentType: "claude_code",
						metadata: {},
						ownerUserId,
						ingestKeyId,
						projectId,
						lastActivityAt: seeded[seeded.length - 1]?.lastActivityAt,
						...row,
					} as never)
					.execute();
			}
		}
	}
});

type ListFilters = NonNullable<Parameters<typeof getSessions>[0]>;

async function pageThrough(filters: ListFilters, pageSize: number) {
	const ids: string[] = [];
	let total = -1;
	for (let offset = 0; ; offset += pageSize) {
		const page = await getSessions({ ...filters, limit: pageSize, offset });
		total = page.total;
		ids.push(...page.sessions.map((s) => s.sessionId));
		if (page.sessions.length < pageSize) return { ids, total };
	}
}

describe("tab filter", () => {
	for (const owner of OWNERS) {
		for (const excludeScratch of [false, true]) {
			test(`the three tabs partition the scope: owner ${owner.label}, ${
				excludeScratch ? "scratch hidden" : "scratch shown"
			}`, async () => {
				const inScope = seeded
					.filter((r) => owner.owns(r))
					.filter((r) => !excludeScratch || r.projectId !== "p-scratch");
				const stats = await getStats({ owner: owner.scope, excludeScratch });
				const seen = new Map<string, Tab[]>();
				for (const tab of TABS) {
					const { ids } = await pageThrough({ owner: owner.scope, excludeScratch, tab }, 11);
					for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), tab]);
				}
				expect([...seen.keys()].sort()).toEqual(inScope.map((r) => r.sessionId).sort());
				for (const [id, tabs] of seen) expect({ id, tabs }).toEqual({ id, tabs: [tabs[0]] });
				const counts = tabCountsOf(stats);
				expect(counts.active + counts.completed + counts.archived).toBe(stats.total);
				expect(stats.completedCount).toBe(counts.completed);
				expect(stats.archivedCount).toBe(counts.archived);
				// The card keeps its own, narrower meaning.
				expect(stats.activeSessions).toBe(inScope.filter((r) => r.legacyActive).length);
			});
		}
	}

	test("stats answer the tab counts in the one aggregate statement", async () => {
		const calls = await countDbCalls(async () => {
			await getStats();
		});
		expect(calls).toBe(2);
	});

	for (const excludeScratch of [false, true]) {
		test(`each owner group carries its own tab counts, scratch ${excludeScratch ? "hidden" : "shown"}`, async () => {
			const { groups } = await getStatsByOwner({ excludeScratch });
			const keyOf = (userId: string | null, hasKey: boolean) =>
				userId ?? (hasKey ? "service" : "unassigned");
			const expected = new Map<string, TabCounts>();
			for (const r of seeded) {
				if (excludeScratch && r.projectId === "p-scratch") continue;
				const key = keyOf(r.ownerUserId, r.ingestKeyId !== null);
				const counts = expected.get(key) ?? { active: 0, completed: 0, archived: 0 };
				counts[r.tab] += 1;
				expected.set(key, counts);
			}
			const actual = new Map(
				groups.map((g) => [keyOf(g.ownerUserId, g.ownerKind === "service"), g.tabCounts]),
			);
			expect(actual).toEqual(expected);
		});
	}

	for (const owner of OWNERS) {
		for (const excludeScratch of [false, true]) {
			test(`each tab lists exactly what its stats count says: owner ${owner.label}, ${
				excludeScratch ? "scratch hidden" : "scratch shown"
			}`, async () => {
				const stats = await getStats({ owner: owner.scope, excludeScratch });
				for (const tab of TABS) {
					const expected = seeded
						.filter((r) => owner.owns(r) && r.tab === tab)
						.filter((r) => !excludeScratch || r.projectId !== "p-scratch")
						.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
						.map((r) => r.sessionId);
					expect(expected.length).toBeGreaterThan(0);
					const { ids, total } = await pageThrough({ owner: owner.scope, excludeScratch, tab }, 7);
					expect({ tab, total }).toEqual({ tab, total: tabCountsOf(stats)[tab] });
					expect({ tab, ids }).toEqual({ tab, ids: expected });
					expect(new Set(ids).size).toBe(ids.length);
				}
			});
		}
	}

	test("it composes with the agent type and the search text", async () => {
		await getDb()
			.update(sessions)
			.set({ agentType: "codex_cli", displayName: "needle" } as never)
			.execute();
		const none = await getSessions({ tab: "active", agentType: "claude_code" });
		expect(none.total).toBe(0);
		const some = await getSessions({ tab: "active", q: "needle", limit: 1 });
		expect(some.total).toBe(seeded.filter((r) => r.tab === "active").length);
		expect(some.sessions).toHaveLength(1);
	});
});

describe("paging with many rows on one timestamp", () => {
	const SAME = "2026-03-01T12:00:00.000Z";
	beforeEach(async () => {
		await getDb().delete(sessions).execute();
		for (let i = 0; i < 40; i += 1) {
			await getDb()
				.insert(sessions)
				.values({
					id: `row-${String(i).padStart(3, "0")}`,
					sessionId: `tie-${i}`,
					displayName: `tie-${i}`,
					agentType: "claude_code",
					metadata: {},
					status: "active",
					lastActivityAt: SAME,
				} as never)
				.execute();
		}
	});

	const newestKeyFirst = Array.from({ length: 40 }, (_, i) => `tie-${39 - i}`);

	for (const tab of [undefined, "active"] as const) {
		test(`every row comes back once and in a fixed order: ${tab ?? "no tab"}`, async () => {
			const { ids, total } = await pageThrough({ tab }, 7);
			expect(total).toBe(40);
			expect(ids).toEqual(newestKeyFirst);
		});

		test(`the projection pages the same way: ${tab ?? "no tab"}`, async () => {
			const ids: string[] = [];
			for (let offset = 0; offset < 40; offset += 7) {
				const page = await getSessionSummaries({ tab, limit: 7, offset }, ["sessionId"]);
				ids.push(...page.map((r) => String(r.sessionId)));
			}
			expect(ids).toEqual(newestKeyFirst);
		});
	}

	test("the operational list pages the same way", async () => {
		const ids: string[] = [];
		for (let offset = 0; offset < 40; offset += 7) {
			const page = await getSessions({ operational: "idle", limit: 7, offset });
			ids.push(...page.sessions.map((s) => s.sessionId));
		}
		expect(ids).toEqual(
			Array.from({ length: 40 }, (_, i) => `tie-${i}`)
				.sort()
				.reverse(),
		);
	});
});
