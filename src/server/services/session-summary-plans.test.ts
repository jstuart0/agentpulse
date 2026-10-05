/**
 * AGEN-69 phase 5 review fixes 2, Q-2: the plans of the activity and stale probes.
 *
 * On Postgres, with statistics (the normal state), `WHERE session_id = $1 ORDER BY id LIMIT n`
 * walks the primary key and filters by session when the session's events sit at the newest ids:
 * hundreds of milliseconds and millions of rows removed per leg at 2M events, on every view and
 * POST. The probes make `session_id` a range and keep it in the sort, so only the composite
 * index (session_id, id) can supply the order. The fixture below is the trap in miniature: an
 * analysed table, the session holding a few percent of it, clustered at the newest ids.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { sql } = await import("drizzle-orm");
const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const H = await import("../test-utils/summary-service-harness.js");
const { getSessionSummaryView } = await import("./session-summary-service.js");

const SID = "plan-s1";
let stub: ReturnType<typeof H.startStub>;

beforeAll(async () => {
	await initializeDatabase();
	stub = H.startStub();
});
afterAll(async () => {
	await stub.stop();
});
beforeEach(async () => {
	await H.resetWorld(stub);
	await H.enableAi();
	await H.seedProvider(stub);
});
afterEach(async () => {
	await H.afterEachGuard(stub);
});

const readEvent = () => ({
	eventType: "PostToolUse",
	category: "tool_event",
	toolName: "Read",
	toolInput: { file_path: "a.ts" },
});

/** The statements of the two probes, captured from a real view of `SID` with a stored summary. */
async function probeStatements() {
	const { statements } = await H.captureStatements(async () => getSessionSummaryView(SID));
	const activity = statements.filter((s) => /\blimit\s+2000\b/i.test(s.text));
	const stale = statements.filter((s) => /count\(/i.test(s.text));
	expect(activity).toHaveLength(1);
	expect(stale).toHaveLength(1);
	return { activity: activity[0], stale: stale[0] };
}

describePostgresOnly("on Postgres, at the trap shape", () => {
	async function seedTrap(): Promise<number> {
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		await db.execute(sql`INSERT INTO sessions (id, session_id, agent_type, status)
			SELECT gen_random_uuid(), 'noise-' || g, 'claude_code', 'active' FROM generate_series(0, 99) g`);
		await db.execute(sql`INSERT INTO events (session_id, event_type, category, raw_payload, created_at)
			SELECT 'noise-' || (g % 100), 'Notification', 'notification', '{}', '2026-10-04 10:00:00'
			FROM generate_series(1, 150000) g`);
		await H.seedSession(SID);
		// The session's events are the newest ids: 6,000 Read-class calls, no prompt, no action.
		const ids = await H.seedEvents(
			SID,
			Array.from({ length: 6000 }, () => readEvent()),
		);
		await db.execute(sql`ANALYZE events`);
		// 4,000 of the session's events are before the threshold, 2,000 after it.
		await H.seedReadySummary(SID, { throughEventId: ids[4000], firstEventId: ids[0] });
		return ids[4000];
	}
	// The fixture leaves 156,000 rows and statistics saying so; the next test file in the same
	// database must not inherit either.
	afterEach(async () => {
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		await db.execute(sql`TRUNCATE events`);
		await db.execute(sql`ANALYZE events`);
	});

	const planOf = async (text: string, params: unknown[], analyse = false): Promise<string> => {
		const client = (
			getDb() as unknown as {
				$client: { unsafe: (text: string, params: unknown[], options: object) => Promise<unknown> };
			}
		).$client;
		const rows = (await client.unsafe(
			`EXPLAIN (${analyse ? "ANALYZE, " : ""}COSTS OFF${analyse ? ", TIMING OFF" : ""}) ${text}`,
			params,
			{
				prepare: false,
			},
		)) as Array<Record<string, string>>;
		return rows.map((r) => r["QUERY PLAN"]).join("\n");
	};

	test("TC-5.64 the fixture is a real trap: the old statement walks events_pkey; neither probe does, and both use idx_events_session_id_id with no sort", async () => {
		await seedTrap();
		const { activity, stale } = await probeStatements();
		// The old statement is the new one with the range turned back into an equality and the
		// session_id sort key dropped: the trap must catch exactly that.
		const oldText = activity.text
			.replace(
				/session_id >= (\$\d+) AND session_id <= (\$\d+)/g,
				"session_id = $1 AND $2::text IS NOT NULL",
			)
			.replace(/ORDER BY session_id (ASC|DESC), id/g, "ORDER BY id");
		const old = await planOf(oldText, activity.params);
		console.log(
			`[plan] old activity statement\n${old.replace(/Filter: .*\(COALESCE.*/g, "Filter: (category rules)")}`,
		);
		expect(old, `the old statement should walk the primary key:\n${old}`).toContain("events_pkey");
		for (const [name, probe] of [
			["activity", activity],
			["stale", stale],
		] as const) {
			const plan = await planOf(probe.text, probe.params);
			console.log(
				`[plan] ${name} probe\n${plan.replace(/Filter: .*\(COALESCE.*/g, "Filter: (category rules)")}`,
			);
			expect(plan, `${name} probe plan:\n${plan}`).not.toContain("events_pkey");
			expect(plan, `${name} probe plan:\n${plan}`).toContain("idx_events_session_id_id");
			expect(plan, `${name} probe plan:\n${plan}`).not.toMatch(/\bSort\b/);
		}
	}, 120_000);

	test("TC-5.64d R3-5 a session spread through an analysed table: the stale probe seeks by the id bound (Index Cond), reads about the window, and uses the composite index with no sort", async () => {
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		await db.execute(sql`INSERT INTO sessions (id, session_id, agent_type, status)
			SELECT gen_random_uuid(), 'noise-' || g, 'claude_code', 'active' FROM generate_series(0, ${sql.raw(String(Number(process.env.PLAN_NOISE ?? 100) - 1))}) g`);
		await H.seedSession(SID);
		// One event in eight is the session's: 20,000 of 160,000, spread through the table.
		await db.execute(sql`INSERT INTO events (session_id, event_type, category, tool_name, raw_payload, created_at)
			SELECT CASE WHEN g % ${sql.raw(String(process.env.PLAN_EVERY ?? 8))} = 0 THEN ${SID} ELSE 'noise-' || (g % ${sql.raw(String(process.env.PLAN_NOISE ?? 100))}) END,
				'PostToolUse', 'tool_event', 'Read', '{}', '2026-10-04 10:00:00'
			FROM generate_series(1, ${sql.raw(String(process.env.PLAN_ROWS ?? 160000))}) g`);
		await db.execute(sql`ANALYZE events`);
		const rows = (await db.execute(
			sql`SELECT id FROM events WHERE session_id = ${SID} ORDER BY id OFFSET ${sql.raw(String(process.env.PLAN_OFFSET ?? 10000))} LIMIT 1`,
		)) as Array<{ id: number }>;
		const first = (await db.execute(
			sql`SELECT min(id) AS id FROM events WHERE session_id = ${SID}`,
		)) as Array<{ id: number }>;
		await H.seedReadySummary(SID, {
			throughEventId: Number(rows[0].id),
			firstEventId: Number(first[0].id),
		});
		const { stale } = await probeStatements();
		const analysed = await planOf(stale.text, stale.params, true);
		console.log(`[plan] stale probe, spread session\n${analysed}`);
		// R3-5: the id bound must be part of the index CONDITION (a seek), not a filter over the
		// whole session behind a sort: the row-comparison form with an upper session bound read
		// every one of the session's events to find the window.
		expect(analysed, `stale probe plan:\n${analysed}`).toMatch(
			/Index Cond: \(ROW\(session_id, id\) > ROW\([^)]*\)\)(?! AND)/,
		);
		expect(analysed, `stale probe plan:\n${analysed}`).toContain("idx_events_session_id_id");
		expect(analysed, `stale probe plan:\n${analysed}`).not.toMatch(/Sort/);
		// No upper session bound in the condition: that form read the whole session on some plans.
		expect(analysed).not.toMatch(/session_id <= /);
		for (const m of analysed.matchAll(/Rows Removed by Filter: (\d+)/g)) {
			expect(Number(m[1]), `stale probe plan:\n${analysed}`).toBeLessThanOrEqual(500);
		}
	}, 120_000);

	test("TC-5.64b the answers are unchanged at the trap shape: promptless and action-free is too little activity, and the oldest id is the session's own", async () => {
		await seedTrap();
		const view = await getSessionSummaryView(SID);
		expect(view?.blocked).toBe("too_little_activity");
		expect(view?.evidenceShrunk).toBe(false);
	}, 120_000);
});

describeSqliteOnly("on SQLite", () => {
	test("TC-5.64c both probes search a session_id index and use no temporary b-tree for the order", async () => {
		await H.seedSession(SID);
		const ids = await H.seedEvents(
			SID,
			Array.from({ length: 300 }, () => readEvent()),
		);
		await H.seedReadySummary(SID, { throughEventId: ids[10], firstEventId: ids[0] });
		// Other sessions hold most of the table (the shape of a real database), then statistics.
		for (let i = 0; i < 20; i++) {
			await H.seedSession(`plan-noise-${i}`);
			await H.seedEvents(
				`plan-noise-${i}`,
				Array.from({ length: 300 }, () => readEvent()),
			);
		}
		getSqlite().exec("ANALYZE");
		const { activity, stale } = await probeStatements();
		for (const [name, probe] of [
			["activity", activity],
			["stale", stale],
		] as const) {
			const plan = (
				getSqlite()
					.prepare(`EXPLAIN QUERY PLAN ${probe.text}`)
					.all(...(probe.params as never[])) as Array<{
					detail: string;
				}>
			)
				.map((r) => r.detail)
				.join("\n");
			// An unanalysed SQLite table may pick the older single-column index; either supplies the order.
			expect(plan, `${name}:\n${plan}`).toMatch(/idx_events_session_id/);
			if (name === "stale") {
				// R3-5: the id bound is part of the SEARCH (a true seek), not evaluated per row.
				expect(plan, `${name}:\n${plan}`).toMatch(
					/idx_events_session_id(_id)? \(session_id=\? AND (id|rowid)>\?\)/,
				);
			}
			expect(plan, `${name}:\n${plan}`).not.toContain("TEMP B-TREE");
		}
	});
});
