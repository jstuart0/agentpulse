/**
 * What the dashboard poll costs the database. getStats and the list run on a
 * timer in every open tab, so their statement shape is pinned: counts, the
 * candidate scan's ordering, and the index the owner-scoped list reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { projects, sessions } = await import("../db/schema/index.js");
const { getSessions, getStats, getStatsByOwner, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const OWNER = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb().delete(projects).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

async function seedSessions(count: number, owner: string | null = OWNER) {
	const rows = Array.from({ length: count }, (_, i) => ({
		sessionId: `cost-${i}`,
		displayName: `cost-${i}`,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		ownerUserId: owner,
		lastAgentTurnCompletedAt: new Date(Date.now() - i * 1000).toISOString(),
		lastActivityAt: new Date(Date.now() - i * 1000).toISOString(),
	}));
	await getDb().insert(sessions).values(rows).execute();
}

describe("statement counts for the poll", () => {
	test("getStats is one aggregate plus one candidate scan, scoped or not", async () => {
		await seedSessions(3);
		const everyone = await countDbCalls(async () => {
			await getStats();
		});
		const scoped = await countDbCalls(async () => {
			await getStats({ owner: { kind: "user", userId: OWNER } });
		});
		expect({ everyone, scoped }).toEqual({ everyone: 2, scoped: 2 });
	});

	test("excluding scratch workspaces adds exactly the project lookup", async () => {
		await seedSessions(1);
		const calls = await countDbCalls(async () => {
			await getStats({ excludeScratch: true });
		});
		expect(calls).toBe(3);
	});

	test("the per-owner grouping is two statements however many owners there are", async () => {
		await seedSessions(2);
		const few = await countDbCalls(async () => {
			await getStatsByOwner();
		});
		await getDb()
			.insert(sessions)
			.values(
				Array.from({ length: 6 }, (_, i) => ({
					sessionId: `owner-fan-${i}`,
					agentType: "claude_code",
					metadata: {},
					ownerUserId: `0000000${i}-0000-4000-8000-000000000000`,
				})),
			)
			.execute();
		const many = await countDbCalls(async () => {
			await getStatsByOwner();
		});
		expect({ few, many }).toEqual({ few: 2, many: 2 });
	});

	test("an operational list is one candidate scan, one page fetch and one managed lookup", async () => {
		await seedSessions(3);
		const calls = await countDbCalls(async () => {
			await getSessions({ operational: "waiting", owner: { kind: "user", userId: OWNER } });
		});
		expect(calls).toBe(3);
	});
});

/** Record every SQL string the SQLite client prepares while `run` executes. */
async function recordSql<T>(run: () => Promise<T>): Promise<{ statements: string[]; result: T }> {
	const statements: string[] = [];
	const db = getSqlite();
	const original = db.prepare.bind(db);
	const prepare = spyOn(db, "prepare").mockImplementation(((query: string) => {
		statements.push(query);
		return original(query);
	}) as never);
	try {
		const result = await run();
		return { statements, result };
	} finally {
		prepare.mockRestore();
	}
}

describeSqliteOnly("candidate scan ordering (SQLite)", () => {
	const candidateScans = (statements: string[]) =>
		statements.filter(
			(s) =>
				s.toLowerCase().includes('"last_user_acknowledged_at"') &&
				s.toLowerCase().includes(" limit "),
		);

	test("under the cap nothing is ordered: no sort over the candidate rows", async () => {
		await seedSessions(5);
		_setOperationalCandidateCapForTest(50);
		const { statements } = await recordSql(() => getStats());
		const scans = candidateScans(statements).map((scan) => scan.toLowerCase());
		expect(scans).toHaveLength(1);
		expect(scans[0]).not.toContain("order by");
	});

	test("over the cap the scan is followed by an attention-tier query and an unsorted fill, never a sort of the whole set", async () => {
		await seedSessions(3);
		await getDb()
			.insert(sessions)
			.values(
				Array.from({ length: 6 }, (_, i) => ({
					sessionId: `quiet-${i}`,
					agentType: "claude_code",
					status: "active",
					metadata: {},
				})),
			)
			.execute();
		_setOperationalCandidateCapForTest(5);
		const { statements, result } = await recordSql(() => getStats());
		expect(result.truncated).toBe(true);
		const scans = candidateScans(statements).map((scan) => scan.toLowerCase());
		expect(scans).toHaveLength(3);
		const [probe, attention, fill] = scans as [string, string, string];
		expect(probe).not.toContain("order by");
		expect(attention).toContain("order by");
		// Only the attention tier is ordered (failures first, then newest); the
		// probe and the fill stay unordered, so the whole set is never sorted.
		expect(attention).toMatch(
			/order by\s+case\s+when[^,]*'failed'[^,]*,[^,]*last_activity_at[^,]*desc/,
		);
		expect(fill).not.toContain("order by");
		for (const scan of [attention, fill]) expect(scan).toMatch(/case\s+when/);
	});
});

describeSqliteOnly("the owner-scoped list reads the owner and last-activity index", () => {
	test("EXPLAIN QUERY PLAN for the page and the total both name idx_sessions_owner_last_activity", async () => {
		await seedSessions(40);
		const { statements } = await recordSql(() =>
			getSessions({ owner: { kind: "user", userId: OWNER }, limit: 10 }),
		);
		const db = getSqlite();
		const page = statements.find(
			(s) => s.includes("order by") && s.includes('"owner_user_id" = ?'),
		);
		const total = statements.find(
			(s) => s.includes("count(*)") && s.includes('"owner_user_id" = ?'),
		);
		expect(page).toBeDefined();
		expect(total).toBeDefined();
		const plan = (query: string, params: unknown[]) => {
			const statement = db.prepare(`EXPLAIN QUERY PLAN ${query}`);
			try {
				return statement
					.all(...(params.slice(0, (query.match(/\?/g) ?? []).length) as never[]))
					.map((row) => String((row as { detail: string }).detail))
					.join(" | ");
			} finally {
				statement.finalize();
			}
		};
		expect(plan(page as string, [OWNER, 10, 0])).toContain("idx_sessions_owner_last_activity");
		expect(plan(total as string, [OWNER])).toContain("idx_sessions_owner_last_activity");
	});
});
