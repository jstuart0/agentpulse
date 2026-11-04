/**
 * The host's sync runs every second while a request is pending, against tables
 * that grow with every managed session on every host. Its one read must be driven
 * from codex_approvals by the (status, expires_at) index and reach managed_sessions
 * and launch_requests by key, never scan them (D11). The statement is the exact
 * one the sync runs (ownedApprovalRowsQuery), at 50k managed sessions with statistics.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { like, sql } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { executeRows } = await import("../db/sql-helpers.js");
const { FTS_BOOTSTRAP_SQL } = await import("../db/fts-ddl.js");
const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, launchRequests, managedSessions, sessions } = await import(
	"../db/schema/index.js"
);
const { ownedApprovalRowsQuery } = await import("./codex-approvals.js");

const SESSIONS = 50_000;
const OWN = 300;
const OPEN = 40;
const HOST = "plan-host";
const PREFIX = "plan-s-";

beforeAll(() => initializeDatabase());
afterAll(async () => {
	const db = getDb();
	await db.delete(codexApprovals).where(like(codexApprovals.sessionId, `${PREFIX}%`));
	await db.delete(managedSessions).where(like(managedSessions.sessionId, `${PREFIX}%`));
	await db.delete(launchRequests).where(like(launchRequests.launchCorrelationId, `${PREFIX}%`));
	if (config.dialect === "sqlite") {
		// Deleting a session fires a trigger that scans the two FTS tables once per row (their session_id
		// is unindexed), which at 50k rows takes minutes. Take the trigger off for this one delete, clear
		// the FTS rows in one scan each, and put it back.
		const sqlite = getSqlite();
		sqlite.exec("DROP TRIGGER IF EXISTS trg_sessions_ad_fts");
		await db.delete(sessions).where(like(sessions.sessionId, `${PREFIX}%`));
		sqlite.exec(`DELETE FROM search_sessions_fts WHERE session_id LIKE '${PREFIX}%'`);
		sqlite.exec(FTS_BOOTSTRAP_SQL);
		return;
	}
	await db.delete(sessions).where(like(sessions.sessionId, `${PREFIX}%`));
}, 120_000);

/**
 * 50k sessions, each with a claimed launch and a managed row, in three set-based statements
 * (a row-by-row seed takes minutes). The host under test owns the first OWN of them.
 */
async function seed() {
	const db = getDb();
	const run = (text: string) => executeRows(db, sql.raw(text));
	const last = SESSIONS - 1;
	if (config.dialect === "postgres") {
		await run(
			`INSERT INTO sessions (id, session_id, agent_type) SELECT 'plan-id-' || i, '${PREFIX}' || i, 'codex_cli' FROM generate_series(0, ${last}) AS i`,
		);
		await run(
			`INSERT INTO launch_requests (id, launch_correlation_id, agent_type, cwd, status, claimed_by_supervisor_id) SELECT 'plan-l-' || i, '${PREFIX}' || i, 'codex_cli', '/work', 'running', CASE WHEN i < ${OWN} THEN '${HOST}' ELSE 'other-host-' || (i % 50) END FROM generate_series(0, ${last}) AS i`,
		);
		await run(
			`INSERT INTO managed_sessions (session_id, launch_request_id, supervisor_id, managed_state) SELECT '${PREFIX}' || i, 'plan-l-' || i, 'irrelevant', 'managed' FROM generate_series(0, ${last}) AS i`,
		);
	} else {
		const series = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${last})`;
		await run(
			`${series} INSERT INTO sessions (id, session_id, agent_type) SELECT 'plan-id-' || i, '${PREFIX}' || i, 'codex_cli' FROM n`,
		);
		await run(
			`${series} INSERT INTO launch_requests (id, launch_correlation_id, agent_type, cwd, status, claimed_by_supervisor_id) SELECT 'plan-l-' || i, '${PREFIX}' || i, 'codex_cli', '/work', 'running', CASE WHEN i < ${OWN} THEN '${HOST}' ELSE 'other-host-' || (i % 50) END FROM n`,
		);
		await run(
			`${series} INSERT INTO managed_sessions (session_id, launch_request_id, supervisor_id, managed_state) SELECT '${PREFIX}' || i, 'plan-l-' || i, 'irrelevant', 'managed' FROM n`,
		);
	}
	const now = new Date().toISOString();
	const rows = Array.from({ length: OWN }, (_, i) => ({
		sessionId: `${PREFIX}${i}`,
		runtimeEpoch: "e",
		rpcId: String(i),
		requestKind: "command",
		threadId: "t",
		turnId: "t",
		itemId: "i",
		presentationHash: "h",
		presentationRevision: 1,
		approvable: true,
		status: i < OPEN ? "pending" : "closed",
		closedReason: i < OPEN ? null : "applied",
		createdAt: now,
		expiresAt: new Date(Date.now() + 600_000 + i).toISOString(),
		updatedAt: now,
	}));
	await db.insert(codexApprovals).values(rows);
}

const syncRead = (listed: string[] = []) =>
	ownedApprovalRowsQuery(getDb(), HOST, listed).toSQL() as { sql: string; params: unknown[] };

describeSqliteOnly("sync plan — SQLite", () => {
	const plan = (q: { sql: string; params: unknown[] }) =>
		(
			getSqlite()
				.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
				.all(...(q.params as never[])) as Array<{
				detail: string;
			}>
		)
			.map((r) => r.detail)
			.join("\n");

	test("the seed is at least 50k managed sessions and the host owns a small share (the fixture means something)", async () => {
		await seed();
		getSqlite().exec("ANALYZE");
		const [counts] = getSqlite()
			.prepare(
				"SELECT (SELECT COUNT(*) FROM managed_sessions WHERE session_id LIKE 'plan-s-%') AS managed, (SELECT COUNT(*) FROM codex_approvals WHERE status = 'pending') AS open",
			)
			.all() as Array<{ managed: number; open: number }>;
		expect(counts?.managed).toBe(SESSIONS);
		expect(counts?.open).toBe(OPEN);
	}, 120_000);

	test("it never scans managed_sessions or launch_requests, with or without ids named", async () => {
		for (const listed of [[], ["a", "b", "c"]]) {
			const text = plan(syncRead(listed));
			expect(text, text).toContain("codex_approvals");
			expect(text, text).not.toMatch(/SCAN managed_sessions/);
			expect(text, text).not.toMatch(/SCAN launch_requests/);
			expect(text, text).not.toMatch(/SCAN m\b|SCAN l\b/);
		}
	}, 60_000);
});

describePostgresOnly("sync plan — Postgres", () => {
	const planOf = async (q: { sql: string; params: unknown[] }) => {
		const client = (
			getDb() as unknown as {
				$client: { unsafe: (text: string, params: unknown[], options: object) => Promise<unknown> };
			}
		).$client;
		const rows = (await client.unsafe(`EXPLAIN (COSTS OFF) ${q.sql}`, q.params, {
			prepare: false,
		})) as Array<Record<string, string>>;
		return rows.map((r) => r["QUERY PLAN"]).join("\n");
	};

	test("it never sequentially scans managed_sessions or launch_requests", async () => {
		await seed();
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		for (const table of ["sessions", "launch_requests", "managed_sessions", "codex_approvals"]) {
			await db.execute(sql.raw(`ANALYZE ${table}`));
		}
		for (const listed of [[], ["a", "b", "c"]]) {
			const text = await planOf(syncRead(listed));
			expect(text, text).not.toMatch(/Seq Scan on (managed_sessions|launch_requests)/);
		}
	}, 180_000);
});
