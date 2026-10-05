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
		await H.seedReadySummary(SID, { throughEventId: ids[100], firstEventId: ids[0] });
		return ids[100];
	}
	const planOf = async (text: string, params: unknown[]): Promise<string> => {
		const client = (getDb() as unknown as { $client: { unsafe: Function } }).$client;
		const rows = (await client.unsafe(`EXPLAIN (COSTS OFF) ${text}`, params, {
			prepare: false,
		})) as Array<Record<string, string>>;
		return rows.map((r) => r["QUERY PLAN"]).join("\n");
	};

	test("TC-5.64 the fixture is a real trap: the old statement walks events_pkey; neither probe does, and both use idx_events_session_id_id with no sort", async () => {
		await seedTrap();
		const old = await planOf(
			`SELECT 1 FROM (SELECT id, category, event_type FROM events WHERE session_id = $1 ORDER BY id ASC LIMIT 2000) o WHERE o.category = 'prompt'`,
			[SID],
		);
		expect(old, `the old oldest-window statement should walk the primary key:\n${old}`).toContain(
			"events_pkey",
		);
		const { activity, stale } = await probeStatements();
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
			expect(plan, `${name}:\n${plan}`).not.toContain("TEMP B-TREE");
		}
	});
});
