/**
 * Concurrent identical dashboard polls share one computation. Every open tab
 * polls the stats on a timer and refetches on session updates, and on SQLite
 * each call blocks the event loop, so N synchronized tabs must cost one scan,
 * not N. Nothing is cached beyond the lifetime of the in-flight computation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { projects, sessions } = await import("../db/schema/index.js");
const {
	findSessionsByOperational,
	getSessions,
	getStats,
	getStatsByOwner,
	_setOperationalCandidateCapForTest,
} = await import("./session-tracker.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const ALICE = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const BOB = "9a1c2d3e-4f5a-4b6f-8a7e-0c1d2e3f4a5b";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb().delete(projects).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

async function seed(owner: string, count: number, prefix: string) {
	const rows = Array.from({ length: count }, (_, i) => ({
		sessionId: `${prefix}-${i}`,
		displayName: `${prefix}-${i}`,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		ownerUserId: owner,
		lastAgentTurnCompletedAt: new Date(Date.now() - i * 1000).toISOString(),
		lastActivityAt: new Date(Date.now() - i * 1000).toISOString(),
	}));
	await getDb().insert(sessions).values(rows).execute();
}

describe("concurrent identical stats calls", () => {
	test("five synchronized callers cost one aggregate and one candidate scan", async () => {
		await seed(ALICE, 3, "a");
		const calls = await countDbCalls(async () => {
			await Promise.all(Array.from({ length: 5 }, () => getStats()));
		});
		expect(calls).toBe(2);
	});

	test("every caller gets the full answer", async () => {
		await seed(ALICE, 3, "a");
		const results = await Promise.all(Array.from({ length: 4 }, () => getStats()));
		for (const result of results) expect(result.operational.waiting).toBe(3);
	});

	test("different owner scopes are never shared", async () => {
		await seed(ALICE, 3, "a");
		await seed(BOB, 1, "b");
		let alice: Awaited<ReturnType<typeof getStats>> | undefined;
		let bob: Awaited<ReturnType<typeof getStats>> | undefined;
		let everyone: Awaited<ReturnType<typeof getStats>> | undefined;
		const calls = await countDbCalls(async () => {
			[alice, bob, everyone] = await Promise.all([
				getStats({ owner: { kind: "user", userId: ALICE } }),
				getStats({ owner: { kind: "user", userId: BOB } }),
				getStats(),
			]);
		});
		expect(calls).toBe(6);
		expect(alice?.operational.waiting).toBe(3);
		expect(bob?.operational.waiting).toBe(1);
		expect(everyone?.operational.waiting).toBe(4);
	});

	test("the scratch exclusion is part of the key", async () => {
		await seed(ALICE, 2, "a");
		const calls = await countDbCalls(async () => {
			await Promise.all([getStats({ excludeScratch: true }), getStats({ excludeScratch: false })]);
		});
		// plain: aggregate + scan; excluding scratch: project lookup + aggregate + scan
		expect(calls).toBe(5);
	});

	test("a computation that fails fails every caller sharing it, and the next call recomputes", async () => {
		await seed(ALICE, 2, "a");
		const db = getDb();
		const select = spyOn(db, "select").mockImplementationOnce((() => {
			throw new Error("statement failed");
		}) as never);
		try {
			const settled = await Promise.allSettled([getStats(), getStats()]);
			expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
		} finally {
			select.mockRestore();
		}
		const after = await getStats();
		expect(after.operational.waiting).toBe(2);
	});

	test("a call after the first has finished recomputes", async () => {
		await seed(ALICE, 2, "a");
		const calls = await countDbCalls(async () => {
			await getStats();
			await getStats();
		});
		expect(calls).toBe(4);
	});

	test("a call after a write sees the write", async () => {
		await seed(ALICE, 2, "a");
		expect((await getStats()).operational.waiting).toBe(2);
		await seed(ALICE, 1, "later");
		expect((await getStats()).operational.waiting).toBe(3);
	});
});

describe("every filter that changes the rows is part of the sharing key", () => {
	const variants: Array<[string, Parameters<typeof getSessions>[0]]> = [
		["agent type", { agentType: "codex_cli" }],
		["project", { projectId: "no-such-project" }],
		["search text", { q: "nothing-matches-this" }],
		["lifecycle status", { status: "completed" }],
		["unassigned owner", { owner: { kind: "unassigned" } }],
		["key-reported owner", { owner: { kind: "service" } }],
	];

	for (const [label, other] of variants) {
		test(`${label}: a call with it is not served the unfiltered call's candidates`, async () => {
			await seed(ALICE, 2, "a");
			const [plain, filtered] = await Promise.all([
				getSessions({ operational: "waiting" }),
				getSessions({ operational: "waiting", ...other }),
			]);
			expect(plain.total).toBe(2);
			expect(filtered.total).toBe(0);
		});
	}
});

describe("concurrent identical operational lists and per-owner groupings", () => {
	test("identical operational lists share one candidate scan", async () => {
		await seed(ALICE, 3, "a");
		const calls = await countDbCalls(async () => {
			await Promise.all(
				Array.from({ length: 4 }, () => getSessions({ operational: "waiting", limit: 2 })),
			);
		});
		// one shared scan, then a page fetch and a managed lookup per caller
		expect(calls).toBe(1 + 4 * 2);
	});

	test("a stats poll and an operational list with the same scope share the candidate scan", async () => {
		await seed(ALICE, 3, "a");
		const calls = await countDbCalls(async () => {
			await Promise.all([getStats(), getSessions({ operational: "waiting" })]);
		});
		// aggregate + one shared scan + page fetch + managed lookup
		expect(calls).toBe(4);
	});

	test("lists with different filters are not shared", async () => {
		await seed(ALICE, 2, "a");
		await seed(BOB, 1, "b");
		const [alice, bob] = await Promise.all([
			getSessions({ operational: "waiting", owner: { kind: "user", userId: ALICE } }),
			getSessions({ operational: "waiting", owner: { kind: "user", userId: BOB } }),
		]);
		expect(alice.total).toBe(2);
		expect(bob.total).toBe(1);
	});

	test("identical per-owner groupings share one computation", async () => {
		await seed(ALICE, 2, "a");
		const calls = await countDbCalls(async () => {
			await Promise.all([getStatsByOwner(), getStatsByOwner(), getStatsByOwner()]);
		});
		expect(calls).toBe(2);
	});
});

describe("what is never shared between concurrent callers", () => {
	const HOUR = 3_600_000;
	const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
	const waitingRow = (
		owner: string,
		tag: string,
		i: number,
		extra: Record<string, unknown> = {},
	) => ({
		sessionId: `${tag}-${i}`,
		displayName: `${tag}-${i}`,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		ownerUserId: owner,
		lastAgentTurnCompletedAt: ago(1000),
		lastActivityAt: ago(i * 1000),
		...extra,
	});
	const groupTotals = (r: Awaited<ReturnType<typeof getStatsByOwner>>) =>
		r.groups.map((g) => [g.ownerUserId, g.total]).sort();

	test("concurrent groupings with different owner scopes and scratch flags each get their own groups", async () => {
		await getDb()
			.insert(projects)
			.values({ id: "p-s", name: "s", cwd: "/s", tags: ["scratch"] } as never)
			.execute();
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 3 }, (_, i) => waitingRow(ALICE, "a", i)),
				...Array.from({ length: 2 }, (_, i) => waitingRow(BOB, "b", i)),
				...Array.from({ length: 4 }, (_, i) => waitingRow(ALICE, "as", i, { projectId: "p-s" })),
			] as never)
			.execute();
		const [all, onlyBob, onlyAlice, hideScratch] = await Promise.all([
			getStatsByOwner(),
			getStatsByOwner({ owner: { kind: "user", userId: BOB } }),
			getStatsByOwner({ owner: { kind: "user", userId: ALICE } }),
			getStatsByOwner({ excludeScratch: true }),
		]);
		expect(groupTotals(all)).toEqual(
			[
				[ALICE, 7],
				[BOB, 2],
			].sort(),
		);
		expect(groupTotals(onlyBob)).toEqual([[BOB, 2]]);
		expect(groupTotals(onlyAlice)).toEqual([[ALICE, 7]]);
		expect(groupTotals(hideScratch)).toEqual(
			[
				[ALICE, 3],
				[BOB, 2],
			].sort(),
		);
	});

	test("a poll and a grouping asked at the same moment each get their own shape, in either order", async () => {
		await getDb()
			.insert(sessions)
			.values(Array.from({ length: 3 }, (_, i) => waitingRow(ALICE, "a", i)) as never)
			.execute();
		for (const order of ["poll-first", "group-first"]) {
			const [poll, grouped] =
				order === "poll-first"
					? await Promise.all([getStats(), getStatsByOwner()])
					: (await Promise.all([getStatsByOwner(), getStats()])).reverse();
			expect((poll as Awaited<ReturnType<typeof getStats>>).operational.waiting).toBe(3);
			expect("groups" in poll).toBe(false);
			expect((grouped as Awaited<ReturnType<typeof getStatsByOwner>>).groups).toHaveLength(1);
			expect("operational" in grouped).toBe(false);
		}
	});

	test("Ask's directory filter is not served the unfiltered poll's rows", async () => {
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 2 }, (_, i) => waitingRow(ALICE, "here", i, { cwd: "/work/here" })),
				...Array.from({ length: 3 }, (_, i) =>
					waitingRow(ALICE, "there", i, { cwd: "/work/there" }),
				),
			] as never)
			.execute();
		const [poll, ask] = await Promise.all([
			getStats(),
			findSessionsByOperational(["waiting"], { cwd: "/work/here", limit: 50 }),
		]);
		expect(poll.operational.waiting).toBe(5);
		expect(ask.rows.map((r) => r.sessionId).sort()).toEqual(["here-0", "here-1"]);
	});

	test("Ask's time window is part of the key too", async () => {
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 2 }, (_, i) =>
					waitingRow(ALICE, "new", i, { lastActivityAt: ago(1000) }),
				),
				...Array.from({ length: 3 }, (_, i) =>
					waitingRow(ALICE, "old", i, { lastActivityAt: ago(10 * HOUR) }),
				),
			] as never)
			.execute();
		const [poll, since, until] = await Promise.all([
			getStats(),
			findSessionsByOperational(["waiting"], { since: ago(HOUR), limit: 50 }),
			findSessionsByOperational(["waiting"], { until: ago(HOUR), limit: 50 }),
		]);
		expect(poll.operational.waiting).toBe(5);
		expect(since.rows).toHaveLength(2);
		expect(until.rows).toHaveLength(3);
	});

	test("past the cap, a poll and a per-owner grouping keep their own tiers, in either order", async () => {
		_setOperationalCandidateCapForTest(4);
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 8 }, (_, i) => waitingRow(ALICE, "flood", i)),
				...Array.from({ length: 2 }, (_, i) =>
					waitingRow(BOB, "quiet", i, { lastActivityAt: ago(10 * HOUR) }),
				),
			] as never)
			.execute();
		for (const first of ["poll", "group"]) {
			const [poll, grouped] =
				first === "poll"
					? await Promise.all([getStats(), getStatsByOwner()])
					: (await Promise.all([getStatsByOwner(), getStats()])).reverse();
			const bob = (grouped as Awaited<ReturnType<typeof getStatsByOwner>>).groups.find(
				(g) => g.ownerUserId === BOB,
			);
			expect(bob?.waiting).toBe(2);
			expect((poll as Awaited<ReturnType<typeof getStats>>).operational.waiting).toBe(4);
		}
	});

	test("a mix of two pages, another state and the poll answers each caller its own", async () => {
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 4 }, (_, i) => waitingRow(ALICE, "w", i)),
				...Array.from({ length: 3 }, (_, i) => ({
					...waitingRow(ALICE, "i", i),
					lastAgentTurnCompletedAt: null,
				})),
			] as never)
			.execute();
		const ids = (r: { sessions: Array<{ sessionId: string }> }) =>
			r.sessions.map((s) => s.sessionId);
		const [page1, page2, idle, poll] = await Promise.all([
			getSessions({ operational: "waiting", limit: 2, offset: 0 }),
			getSessions({ operational: "waiting", limit: 2, offset: 2 }),
			getSessions({ operational: "idle", limit: 50 }),
			getStats(),
		]);
		expect(ids(page1)).toEqual(["w-0", "w-1"]);
		expect(ids(page2)).toEqual(["w-2", "w-3"]);
		expect(ids(idle).sort()).toEqual(["i-0", "i-1", "i-2"]);
		expect(page1.total).toBe(4);
		expect(poll.operational).toEqual({ waiting: 4, working: 0, idle: 3, error: 0 });
	});

	test("a poll and three lists on one scope cost one aggregate, one shared scan and a page lookup per list", async () => {
		await getDb()
			.insert(sessions)
			.values([
				...Array.from({ length: 4 }, (_, i) => waitingRow(ALICE, "w", i)),
				...Array.from({ length: 3 }, (_, i) => ({
					...waitingRow(ALICE, "i", i),
					lastAgentTurnCompletedAt: null,
				})),
			] as never)
			.execute();
		const calls = await countDbCalls(async () => {
			await Promise.all([
				getStats(),
				getSessions({ operational: "waiting", limit: 2 }),
				getSessions({ operational: "idle" }),
				getSessions({ operational: "waiting", limit: 2, offset: 2 }),
			]);
		});
		expect(calls).toBe(2 + 3 * 2);
	});
});
