/**
 * AGEN-27: migration-0005 (pg_trgm GIN indexes) correctness.
 *
 * Two things `PostgresSearchBackend`'s own test suite can't cover because
 * they're properties of the migration/index, not the query-building class:
 *
 *   1. The planner actually uses the trigram index (not a sequential scan)
 *      once the table is large enough for the planner to prefer it.
 *   2. The migration degrades gracefully — no thrown error, no broken
 *      search — when pg_trgm can't be installed (simulated here via a
 *      Postgres role with no CREATE privilege, the real-world failure mode
 *      on managed providers that restrict extensions to superuser).
 *
 * Gated by AGENTPULSE_TEST_BACKEND=postgres (describePostgresOnly) — these
 * tests need a real Postgres connection and take tens of seconds to seed.
 */

import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { config } from "../config.js";
import { describePostgresOnly } from "../test-utils/backend.js";

// The plan's floor is 50k rows, but at 50k-60k rows in a small test
// container Postgres's cost-based planner still finds a sequential scan
// cheaper than the bitmap trigram scan (empirically verified: 60k → seq
// scan, 150k+ → index, regardless of match selectivity) — the crossover
// point is sensitive to page count, not just row count, and this container
// has no realistic buffer-cache pressure to tip it earlier. 200k clears
// that crossover with margin while comfortably exceeding the 50k floor.
const ROW_COUNT = 200_000;

type ExplainNode = {
	"Node Type"?: string;
	"Index Name"?: string;
	"Relation Name"?: string;
	Plans?: ExplainNode[];
};
type ExplainRow = { "QUERY PLAN": Array<{ Plan: ExplainNode }> };

function collectNodes(node: ExplainNode, out: ExplainNode[] = []): ExplainNode[] {
	out.push(node);
	for (const child of node.Plans ?? []) collectNodes(child, out);
	return out;
}

describePostgresOnly("AGEN-27: pg_trgm search index (live Postgres)", () => {
	const cleanupConnections: Array<{ end: () => Promise<void> }> = [];
	afterAll(async () => {
		for (const conn of cleanupConnections) await conn.end();
	});

	test("events search predicate is served by the trigram index (not a sequential scan) at >=50k rows", async () => {
		const { getDb, initializeDatabase } = await import("./client.js");
		const { sessions } = await import("./schema/index.js");
		const { executeRows } = await import("./sql-helpers.js");
		await initializeDatabase();

		const db = getDb();
		const sid = `agen27-perf-${crypto.randomUUID()}`;
		const marker = `agen27mk${crypto.randomUUID().replace(/-/g, "")}`;

		await db
			.insert(sessions)
			.values({ sessionId: sid, agentType: "claude_code", status: "active" })
			.execute();

		// Bulk-seed >= 50k events across a mix of indexed and non-indexed
		// event types. The marker (the search term) lands in only 1 row per
		// 5000 — a rare, realistic hit rate, not the ~20% a naive "every
		// 5th row" fixture would give (which is unrealistically easy for a
		// seq scan and hides the index's actual advantage).
		await executeRows(
			db as unknown as import("./client.js").Db,
			sql`
					INSERT INTO events (session_id, event_type, content, raw_payload, created_at)
					SELECT
						${sid},
						(ARRAY['UserPromptSubmit','AssistantMessage','Stop','PreToolUse','PostToolUse'])[1 + (g % 5)],
						CASE WHEN g % 5 = 2 THEN 'Turn completed' ELSE 'refactor payload ' || g END,
						CASE WHEN g % 5 = 0 THEN
							CASE WHEN g % 5000 = 0 THEN json_build_object('prompt', 'refactor payload ' || g || ' ' || ${marker})
								ELSE json_build_object('prompt', 'refactor payload ' || g) END
							ELSE '{}'::json END,
						now()::text
					FROM generate_series(1, ${ROW_COUNT}) AS g
				`,
		);
		// A freshly bulk-inserted table has no statistics yet; without them
		// the planner may still cost a seq scan as cheaper than it actually
		// is. ANALYZE makes the plan choice deterministic for this test.
		await executeRows(db as unknown as import("./client.js").Db, sql`ANALYZE events`);

		const searchSql = sql`
				SELECT e.id, e.session_id, e.event_type, e.created_at
				FROM events e
				WHERE (e.content ILIKE ${`%${marker}%`} OR (e.raw_payload->>'prompt') ILIKE ${`%${marker}%`})
					AND e.event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest')
				ORDER BY e.created_at DESC, e.id DESC
				LIMIT 50
			`;

		const rows = await executeRows<ExplainRow>(
			db as unknown as import("./client.js").Db,
			sql`EXPLAIN (FORMAT JSON) ${searchSql}`,
		);

		const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
		expect(plan).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted defined above
		const nodes = collectNodes(plan!);
		const nodeTypes = nodes.map((n) => n["Node Type"]);
		const indexNames = nodes.map((n) => n["Index Name"]).filter(Boolean);

		expect(nodeTypes).not.toContain("Seq Scan");
		expect(indexNames.some((name) => name?.startsWith("idx_events_"))).toBe(true);

		// Before/after latency, same data, same query, one dedicated
		// connection (SET is session-scoped — the pooled `db` could route
		// the follow-up query to a different physical connection and
		// silently lose the setting): force a sequential scan (index
		// disabled) vs. the planner's normal choice (the trigram index).
		// Reported, not gated on a specific ratio — container I/O varies
		// too much for a stable threshold, but the direction should hold.
		const timingConn = postgres(config.databaseUrl, { max: 1 });
		cleanupConnections.push(timingConn);
		const searchText = `
				SELECT e.id, e.session_id, e.event_type, e.created_at
				FROM events e
				WHERE (e.content ILIKE $1 OR (e.raw_payload->>'prompt') ILIKE $1)
					AND e.event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest')
				ORDER BY e.created_at DESC, e.id DESC
				LIMIT 50
			`;
		const pattern = `%${marker}%`;

		await timingConn.unsafe("SET enable_indexscan = off; SET enable_bitmapscan = off;");
		const seqStart = performance.now();
		await timingConn.unsafe(searchText, [pattern]);
		const seqMs = performance.now() - seqStart;

		await timingConn.unsafe("SET enable_indexscan = on; SET enable_bitmapscan = on;");
		const idxStart = performance.now();
		await timingConn.unsafe(searchText, [pattern]);
		const idxMs = performance.now() - idxStart;

		console.log(
			`[AGEN-27] events search latency at ${ROW_COUNT} rows — seq scan: ${seqMs.toFixed(1)}ms, trigram index: ${idxMs.toFixed(1)}ms`,
		);
		expect(idxMs).toBeLessThan(seqMs);

		// Cleanup: this suite's other files (e.g. ingest-copilot.test.ts) run
		// an unfiltered `DELETE FROM events` in beforeEach — leaving this
		// test's 200k rows behind turns that into a full-table delete on a
		// bloated table and can blow past their 5s hook timeout. Targeted by
		// session_id so it's a fast, indexed delete, not a table scan.
		await executeRows(
			db as unknown as import("./client.js").Db,
			sql`DELETE FROM events WHERE session_id = ${sid}`,
		);
		await executeRows(
			db as unknown as import("./client.js").Db,
			sql`DELETE FROM sessions WHERE session_id = ${sid}`,
		);
	}, 30_000);

	test("sessions search predicate is served by the trigram index (not a sequential scan) at >=50k rows", async () => {
		const { getDb, initializeDatabase } = await import("./client.js");
		const { executeRows } = await import("./sql-helpers.js");
		await initializeDatabase();

		const db = getDb();
		const marker = `agen27smk${crypto.randomUUID().replace(/-/g, "")}`;

		await executeRows(
			db as unknown as import("./client.js").Db,
			sql`
					INSERT INTO sessions (id, session_id, display_name, agent_type, status, cwd)
					SELECT
						gen_random_uuid()::text,
						'agen27-perf-sess-' || g,
						CASE WHEN g % 5000 = 0 THEN 'session ' || g || ' ' || ${marker} ELSE 'session ' || g END,
						'claude_code',
						'active',
						'/home/user/proj' || g
					FROM generate_series(1, ${ROW_COUNT}) AS g
				`,
		);
		await executeRows(db as unknown as import("./client.js").Db, sql`ANALYZE sessions`);

		const rows = await executeRows<ExplainRow>(
			db as unknown as import("./client.js").Db,
			sql`
					EXPLAIN (FORMAT JSON)
					SELECT session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at
					FROM sessions
					WHERE (display_name ILIKE ${`%${marker}%`} OR cwd ILIKE ${`%${marker}%`} OR current_task ILIKE ${`%${marker}%`} OR notes ILIKE ${`%${marker}%`})
					ORDER BY started_at DESC
					LIMIT 50
				`,
		);

		const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
		expect(plan).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted defined above
		const nodes = collectNodes(plan!);
		const nodeTypes = nodes.map((n) => n["Node Type"]);
		const indexNames = nodes.map((n) => n["Index Name"]).filter(Boolean);

		expect(nodeTypes).not.toContain("Seq Scan");
		expect(indexNames.some((name) => name?.startsWith("idx_sessions_"))).toBe(true);

		// Cleanup — see the events test above for why this matters to the
		// rest of the suite.
		await executeRows(
			db as unknown as import("./client.js").Db,
			sql`DELETE FROM sessions WHERE session_id LIKE 'agen27-perf-sess-%'`,
		);
	}, 30_000);

	test("gracefully skips the trigram index when pg_trgm can't be installed (simulated low-privilege role)", async () => {
		// A dedicated scratch DATABASE, not just a scratch table: pg_trgm is
		// installed per-database, and the shared `agentpulse_test` database
		// already has it (migration 0005 installed it for the real
		// sessions/events indexes other tests in this file depend on).
		// Revoking/dropping it there would contaminate every other test.
		// A throwaway database gives a clean "pg_trgm never installed" world
		// with zero blast radius on the rest of the suite.
		const admin = postgres(config.databaseUrl, { max: 1 });
		cleanupConnections.push(admin);

		const roleName = `agen27_lowpriv_${Math.random().toString(36).slice(2, 10)}`;
		const scratchDbName = `agen27_scratch_${Math.random().toString(36).slice(2, 10)}`;

		await admin.unsafe(`CREATE DATABASE "${scratchDbName}"`);

		const scratchAdminUrl = new URL(config.databaseUrl);
		scratchAdminUrl.pathname = `/${scratchDbName}`;
		const scratchAdmin = postgres(scratchAdminUrl.toString(), { max: 1 });
		cleanupConnections.push(scratchAdmin);

		await scratchAdmin.unsafe("CREATE TABLE agen27_events (id serial primary key, content text)");
		await scratchAdmin.unsafe(
			`INSERT INTO agen27_events (content) VALUES ('needle in a haystack')`,
		);
		await scratchAdmin.unsafe(`CREATE ROLE "${roleName}" LOGIN PASSWORD 'agen27_test_only'`);
		await scratchAdmin.unsafe(`REVOKE CREATE ON SCHEMA public FROM "${roleName}"`);
		await scratchAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
		await scratchAdmin.unsafe(`GRANT SELECT ON agen27_events TO "${roleName}"`);

		const lowPrivUrl = new URL(scratchAdminUrl.toString());
		lowPrivUrl.username = roleName;
		lowPrivUrl.password = "agen27_test_only";
		// onnotice suppressed: the DO blocks below deliberately RAISE NOTICE on
		// the expected (no-privilege) path, and this is a low-noise test log.
		const lowPriv = postgres(lowPrivUrl.toString(), { max: 1, onnotice: () => {} });
		cleanupConnections.push(lowPriv);

		// The exact shape of migration 0005's two DO blocks, run as the
		// low-privilege role against the fresh (pg_trgm-free) scratch
		// database. Must not throw.
		//
		// Plain awaits, not `expect(promise).resolves` — wrapping a
		// postgres-js `.unsafe()` DO-block call (multi-line, no bind params,
		// NOTICE-emitting) in `expect().resolves` reproducibly hangs under
		// bun:test in this environment (isolated and confirmed: identical
		// plain `await` calls resolve in <200ms; the same call wrapped in
		// `expect(...).resolves` never settles). Root cause not pinned down
		// further (suspected bun:test/postgres-js interaction); asserting on
		// the already-awaited result sidesteps it entirely.
		const doResult1 = await lowPriv.unsafe(`
			DO $$
			BEGIN
				BEGIN
					CREATE EXTENSION IF NOT EXISTS pg_trgm;
				EXCEPTION WHEN OTHERS THEN
					RAISE NOTICE 'pg_trgm unavailable (%): falling back to sequential scan.', SQLERRM;
				END;
			END $$;
		`);
		expect(doResult1).toBeDefined();

		const doResult2 = await lowPriv.unsafe(`
			DO $$
			BEGIN
				IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
					CREATE INDEX IF NOT EXISTS idx_agen27_events_content_trgm ON agen27_events USING gin (content gin_trgm_ops);
				ELSE
					RAISE NOTICE 'pg_trgm not installed — skipping trigram search index.';
				END IF;
			END $$;
		`);
		expect(doResult2).toBeDefined();

		// pg_trgm must genuinely be absent (not just untested) for this to be
		// a real assertion about the fallback path, not a no-op.
		const ext = await scratchAdmin.unsafe(
			`SELECT 1 AS present FROM pg_extension WHERE extname = 'pg_trgm'`,
		);
		expect(ext.length).toBe(0);

		const idx = await scratchAdmin.unsafe(
			`SELECT 1 AS present FROM pg_indexes WHERE indexname = 'idx_agen27_events_content_trgm'`,
		);
		expect(idx.length).toBe(0);

		// Search still works — correct results via sequential scan.
		const hits = await lowPriv.unsafe(
			`SELECT id FROM agen27_events WHERE content ILIKE '%haystack%'`,
		);
		expect(hits.length).toBe(1);

		await lowPriv.end();
		cleanupConnections.splice(cleanupConnections.indexOf(lowPriv), 1);
		await scratchAdmin.end();
		cleanupConnections.splice(cleanupConnections.indexOf(scratchAdmin), 1);
		await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
		await admin.unsafe(`DROP ROLE IF EXISTS "${roleName}"`);
	}, 30_000);
});
