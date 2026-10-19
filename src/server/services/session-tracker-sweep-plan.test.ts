/**
 * The sweep's UPDATEs must keep using an index: the silence ceiling narrows
 * the protected id list in JS precisely so that no `OR last_activity_at < ?`
 * lands in the WHERE (that form planned as `SCAN sessions`).
 */
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { sweepConditions } = await import("./session-tracker.js");

// These two indexes come from the legacy init path (db/client.ts) that existing
// installs run; a fresh Drizzle-migrate database doesn't have them, so the plan
// would depend on which test file ran first. Create them as client.ts does, so
// the test pins how the UPDATE shapes use the indexes production installs have.
beforeAll(async () => {
	await initializeDatabase();
	getSqlite().exec(
		"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);" +
			"CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);",
	);
});

describeSqliteOnly("sweep UPDATE plans", () => {
	const cutoff = new Date().toISOString();
	const conditions = sweepConditions({
		idleCutoff: cutoff,
		endCutoff: cutoff,
		stuckWorkingCutoff: cutoff,
		protectedIds: ["a", "b"],
	});

	/** The plan on a scratch copy of the real sessions DDL, optionally without one index. */
	function plan(
		where: ReturnType<typeof sweepConditions>[keyof ReturnType<typeof sweepConditions>],
		droppedIndex?: string,
	) {
		const { sql, params } = getDb()
			.update(sessions)
			.set({ status: "completed", endedAt: cutoff })
			.where(where)
			.toSQL();
		const ddl = getSqlite()
			.prepare(
				"SELECT sql FROM sqlite_master WHERE tbl_name = 'sessions' AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY (type = 'table') DESC",
			)
			.all() as { sql: string }[];
		const scratch = new Database(":memory:");
		try {
			for (const row of ddl) scratch.exec(row.sql);
			if (droppedIndex) scratch.exec(`DROP INDEX ${droppedIndex}`);
			const rows = scratch.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
				detail: string;
			}[];
			return rows.map((r) => r.detail);
		} finally {
			scratch.close();
		}
	}

	// The index each statement uses today, and so the one whose loss must show.
	const expectedIndex = {
		stuckWorking: "idx_sessions_last_activity",
		idle: "idx_sessions_status",
		end: "idx_sessions_status",
	} as const;

	for (const name of ["stuckWorking", "idle", "end"] as const) {
		const index = expectedIndex[name];

		test(`${name} uses ${index} and never a bare table scan`, () => {
			const details = plan(conditions[name]);
			expect(
				details.some(
					(d) => d.includes(`USING INDEX ${index}`) || d.includes(`USING COVERING INDEX ${index}`),
				),
			).toBe(true);
			expect(details.some((d) => /SCAN sessions\s*$/.test(d))).toBe(false);
		});

		test(`${name}: dropping ${index} loses that index, so the check above can fail`, () => {
			const details = plan(conditions[name], index);
			expect(details.join("\n")).not.toContain(index);
		});
	}
});
