/**
 * The indexes migration 0016 adds for the stats poll's "launches requested today" count and for the Ask
 * thread lists, on both dialects: they exist, and the planner uses the launch one for the real subquery.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { sql } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("./client.js");
const { launchRequests } = await import("./schema/index.js");
const { executeRows } = await import("./sql-helpers.js");
const { launchesTodaySubquery } = await import("../services/session-tracker.js");

beforeAll(() => initializeDatabase(), 60_000);

async function indexNames(table: string): Promise<string[]> {
	const rows =
		config.dialect === "postgres"
			? await executeRows<{ name: string }>(
					getDb(),
					sql`SELECT indexname AS name FROM pg_indexes WHERE tablename = ${table}`,
				)
			: await executeRows<{ name: string }>(
					getDb(),
					sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table}`,
				);
	return rows.map((r) => r.name);
}

describe("migration 0016 indexes", () => {
	test("the launch and Ask owner indexes exist", async () => {
		expect(await indexNames("launch_requests")).toContain("idx_launch_requests_created_at");
		const ask = await indexNames("ask_threads");
		expect(ask).toContain("idx_ask_threads_owner_user");
		expect(ask).toContain("idx_ask_threads_owner_key");
	});

	test("the Ask owner indexes are partial (active threads only)", async () => {
		const defs =
			config.dialect === "postgres"
				? await executeRows<{ def: string }>(
						getDb(),
						sql`SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'ask_threads' AND indexname LIKE 'idx_ask_threads_owner_%'`,
					)
				: await executeRows<{ def: string }>(
						getDb(),
						sql`SELECT sql AS def FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ask_threads_owner_%'`,
					);
		expect(defs).toHaveLength(2);
		for (const { def } of defs) expect(def).toMatch(/archived_at.*IS NULL/);
	});

	test("launchesToday's subquery is answered from idx_launch_requests_created_at", async () => {
		const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
		await getDb().delete(launchRequests);
		const rows = Array.from({ length: 3000 }, (_, i) => ({
			launchCorrelationId: `idx-${i}-${crypto.randomUUID()}`,
			agentType: "claude_code",
			cwd: "/tmp/x",
			status: "completed",
			createdAt: old,
		}));
		for (let i = 0; i < rows.length; i += 500) {
			await getDb()
				.insert(launchRequests)
				.values(rows.slice(i, i + 500) as never);
		}
		if (config.dialect !== "postgres") await executeRows(getDb(), sql`ANALYZE`);
		else await executeRows(getDb(), sql`ANALYZE launch_requests`);

		const todayStart = new Date(Date.now() - 3600_000).toISOString();
		const subquery = launchesTodaySubquery({}, todayStart);
		const plan = await executeRows<Record<string, unknown>>(
			getDb(),
			config.dialect === "postgres"
				? sql`EXPLAIN SELECT ${subquery}`
				: sql`EXPLAIN QUERY PLAN SELECT ${subquery}`,
		);
		const text = JSON.stringify(plan);
		expect(text).toContain("idx_launch_requests_created_at");
		expect(text).not.toMatch(/Seq Scan on launch_requests|SCAN launch_requests(?! USING)/);
		await getDb().delete(launchRequests);
	});
});
