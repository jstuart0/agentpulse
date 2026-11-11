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
const { sweepConditions } = await import("./session-tracker.js");

const SESSIONS = 50_000;
const OWN = 300;
const OPEN = 40;
const HOST = "plan-host";
const PREFIX = "plan-s-";

/** Removes every row the seed makes. Safe to run on a clean database, and on one a crashed run left behind. */
async function cleanSeed() {
	const db = getDb();
	await db.delete(codexApprovals).where(like(codexApprovals.sessionId, `${PREFIX}%`));
	await db.delete(managedSessions).where(like(managedSessions.sessionId, `${PREFIX}%`));
	await db.delete(launchRequests).where(like(launchRequests.launchCorrelationId, `${PREFIX}%`));
	if (config.dialect === "sqlite") {
		// Deleting a session fires a trigger that scans the two FTS tables once per row (their session_id
		// is unindexed), which at 50k rows takes minutes. Take the trigger off for this one delete, clear
		// the FTS rows in one scan each, and put it back, whatever happens in between.
		const sqlite = getSqlite();
		sqlite.exec("DROP TRIGGER IF EXISTS trg_sessions_ad_fts");
		try {
			await db.delete(sessions).where(like(sessions.sessionId, `${PREFIX}%`));
			sqlite.exec(`DELETE FROM search_sessions_fts WHERE session_id LIKE '${PREFIX}%'`);
		} finally {
			sqlite.exec(FTS_BOOTSTRAP_SQL);
		}
		return;
	}
	await db.delete(sessions).where(like(sessions.sessionId, `${PREFIX}%`));
}

beforeAll(async () => {
	await initializeDatabase();
	await cleanSeed();
	await seed();
	// SQLite is left as the server leaves it: nothing in the server runs ANALYZE, and with the
	// statistics an operator's ANALYZE would add, SQLite sees a two-valued `status` column as
	// unselective and scans codex_approvals (bounded by its size). Postgres needs its statistics.
	if (config.dialect === "sqlite") {
		// Other suites in the same process ANALYZE this shared database, before this seed existed. Give the
		// two big tables statistics that describe the seed, and leave codex_approvals with none, which is
		// how a server (that never runs ANALYZE) sees it: with its two-valued `status`, statistics would
		// make SQLite scan it.
		const sqlite = getSqlite();
		const lookup = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'");
		const hasStats = lookup.get();
		lookup.finalize();
		if (hasStats) sqlite.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'codex_approvals'");
		sqlite.exec("ANALYZE managed_sessions");
		sqlite.exec("ANALYZE launch_requests");
		return;
	}
	const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
	for (const table of ["sessions", "launch_requests", "managed_sessions", "codex_approvals"]) {
		await db.execute(sql.raw(`ANALYZE ${table}`));
	}
}, 240_000);
afterAll(cleanSeed, 120_000);

const STATUS_EXPIRES_INDEX = "idx_codex_approvals_status_expires";

/**
 * 50k sessions, each with a claimed launch and a managed row, in three set-based statements
 * (a row-by-row seed takes minutes). The host under test owns the first OWN of them.
 */
async function seed() {
	const db = getDb();
	const run = (text: string) => executeRows(db, sql.raw(text));
	const last = SESSIONS - 1;
	const now = new Date().toISOString();
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

	// The pile retention leaves behind: a closed row for every other session. The sync must reach the
	// few open rows through the status index, which only pays off against a table like this one.
	const closedColumns =
		"id, session_id, runtime_epoch, rpc_id, request_kind, thread_id, turn_id, item_id, presentation_hash, presentation_revision, approvable, can_cancel, status, closed_reason, created_at, expires_at, updated_at";
	const closedValues = (i: string) =>
		`'plan-a-' || ${i}, '${PREFIX}' || ${i}, 'e', '0', 'command', 't', 't', 'i', 'h', 1, ${config.dialect === "postgres" ? "true" : "1"}, ${config.dialect === "postgres" ? "false" : "0"}, 'closed', 'applied', '${now}', '${now}', '${now}'`;
	if (config.dialect === "postgres") {
		await run(
			`INSERT INTO codex_approvals (${closedColumns}) SELECT ${closedValues("i")} FROM generate_series(${OWN}, ${last}) AS i`,
		);
	} else {
		await run(
			`WITH RECURSIVE n(i) AS (SELECT ${OWN} UNION ALL SELECT i + 1 FROM n WHERE i < ${last}) INSERT INTO codex_approvals (${closedColumns}) SELECT ${closedValues("i")} FROM n`,
		);
	}
}

/**
 * The inactivity sweep's completion statement (AGEN-94), built from the same conditions the sweep runs.
 * It must find sessions by their status and each candidate's open approvals by (session_id, status),
 * at 50k sessions, never by scanning either table.
 */
const sweepEnd = () => {
	const cutoff = new Date().toISOString();
	const { end } = sweepConditions({
		idleCutoff: cutoff,
		endCutoff: cutoff,
		stuckWorkingCutoff: cutoff,
		approvalHoldCutoff: cutoff,
		protectedIds: ["a", "b"],
	});
	return getDb()
		.update(sessions)
		.set({ status: "completed", endedAt: cutoff })
		.where(end)
		.toSQL() as { sql: string; params: unknown[] };
};

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

	test("the seed is at least 50k managed sessions and the host owns a small share (the fixture means something)", () => {
		const [counts] = getSqlite()
			.prepare(
				"SELECT (SELECT COUNT(*) FROM managed_sessions WHERE session_id LIKE 'plan-s-%') AS managed, (SELECT COUNT(*) FROM codex_approvals WHERE status = 'pending') AS open",
			)
			.all() as Array<{ managed: number; open: number }>;
		expect(counts?.managed).toBe(SESSIONS);
		expect(counts?.open).toBe(OPEN);
	});

	test("it reads codex_approvals through the (status, expires_at) index and never scans a table, with or without ids named", () => {
		for (const listed of [[], ["a", "b", "c"]]) {
			const text = plan(syncRead(listed));
			expect(text, text).toContain(`SEARCH codex_approvals USING INDEX ${STATUS_EXPIRES_INDEX}`);
			expect(text, text).not.toMatch(/SCAN codex_approvals/);
			expect(text, text).not.toMatch(/SCAN managed_sessions/);
			expect(text, text).not.toMatch(/SCAN launch_requests/);
			expect(text, text).not.toMatch(/SCAN m\b|SCAN l\b/);
		}
	});
});

describeSqliteOnly("sweep end plan — SQLite", () => {
	test("sessions by an index, approvals by (session_id, status), no table scan", () => {
		// A fresh Drizzle database lacks the legacy-init index the installs the sweep runs on have.
		getSqlite().exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)");
		const q = sweepEnd();
		const text = (
			getSqlite()
				.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
				.all(...(q.params as never[])) as Array<{ detail: string }>
		)
			.map((r) => r.detail)
			.join("\n");
		// Which sessions index leads depends on the statistics other suites left; either is a seek, not a scan.
		expect(text, text).toMatch(/SEARCH sessions USING INDEX idx_sessions_(status|last_activity)/);
		expect(text, text).toContain(
			"SEARCH codex_approvals USING INDEX idx_codex_approvals_session_status",
		);
		expect(text, text).not.toMatch(/SCAN (sessions|codex_approvals)/);
	});
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
		for (const listed of [[], ["a", "b", "c"]]) {
			const text = await planOf(syncRead(listed));
			expect(text, text).toContain("codex_approvals");
			expect(text, text).not.toMatch(
				/Seq Scan on (managed_sessions|launch_requests|codex_approvals)/,
			);
		}
	});
});

describePostgresOnly("sweep end plan — Postgres", () => {
	// Postgres has no index on sessions.status or last_activity_at, so the sweep's statement scans sessions
	// with or without the approval check (measured on the base statement too); what the check must not add
	// is a scan of codex_approvals.
	test("reaches codex_approvals by an index and never sequentially scans it", async () => {
		const client = (
			getDb() as unknown as {
				$client: { unsafe: (text: string, params: unknown[], options: object) => Promise<unknown> };
			}
		).$client;
		const q = sweepEnd();
		const rows = (await client.unsafe(`EXPLAIN (COSTS OFF) ${q.sql}`, q.params, {
			prepare: false,
		})) as Array<Record<string, string>>;
		const text = rows.map((r) => r["QUERY PLAN"]).join("\n");
		expect(text, text).toMatch(
			/Index (Only )?Scan using idx_codex_approvals_\w+ on codex_approvals/,
		);
		expect(text, text).not.toMatch(/Seq Scan on codex_approvals/);
	});
});
