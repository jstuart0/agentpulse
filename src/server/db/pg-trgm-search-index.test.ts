/**
 * AGEN-27: migration-0006 (pg_trgm GIN indexes) correctness.
 *
 * Several things `PostgresSearchBackend`'s own test suite can't cover
 * because they're properties of the migration/index, not the
 * query-building class:
 *
 *   1. The planner actually uses the trigram index (not a sequential scan)
 *      once the table is large enough for the planner to prefer it.
 *   2. The migration degrades gracefully — no thrown error, no broken
 *      search — when pg_trgm can't be installed (simulated here via a
 *      Postgres role with no CREATE privilege, the real-world failure mode
 *      on managed providers that restrict extensions to superuser).
 *   3. (percy AGEN-27 review, Critical 2) an index-build failure partway
 *      through is caught and warned about, never propagated — a prior
 *      statement in the same migration transaction survives, and the
 *      transaction itself is never left in an aborted state.
 *   4. (percy AGEN-27 review, High 3) the automatic index build is skipped
 *      — with a warning pointing at the CONCURRENTLY recipe — when
 *      `events` is already large; a small/fresh install still gets the
 *      automatic build.
 *
 * Gated by AGENTPULSE_TEST_BACKEND=postgres (describePostgresOnly) — these
 * tests need a real Postgres connection and take tens of seconds to seed.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { config } from "../config.js";
import { describePostgresOnly } from "../test-utils/backend.js";

/**
 * Read migration 0006's own statements off disk (split on drizzle-kit's
 * `--> statement-breakpoint` marker) rather than hand-copying the DO block
 * text into the test — the Critical 2 / High 3 tests below need to
 * exercise the *actual* committed migration, not a copy that can silently
 * drift out of sync with it.
 */
function readMigration0006Statements(): string[] {
	const migrationPath = join(
		import.meta.dir,
		"../../../drizzle/postgres/0006_agen27_pg_trgm_search_index.sql",
	);
	return readFileSync(migrationPath, "utf-8")
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => {
			// Drop segments that are pure `--`-comment (the file's long header)
			// — not executable SQL, so not a "statement" for this test's
			// purposes.
			const withoutComments = s
				.split("\n")
				.filter((line) => !line.trim().startsWith("--"))
				.join("\n")
				.trim();
			return withoutComments.length > 0;
		});
}

/**
 * A dedicated scratch DATABASE (not a scratch table): pg_trgm and
 * pg_class.reltuples are both database-scoped, and the shared
 * `agentpulse_test` database already carries the real indexes other tests
 * in this file depend on — mutating either there would contaminate every
 * other test. Mirrors the pattern already proven out in "gracefully skips
 * the trigram index when pg_trgm can't be installed" below.
 */
async function createScratchDb(adminUrl: string): Promise<{
	admin: ReturnType<typeof postgres>;
	scratchAdmin: ReturnType<typeof postgres>;
	scratchDbName: string;
	cleanup: () => Promise<void>;
}> {
	const admin = postgres(adminUrl, { max: 1 });
	const scratchDbName = `agen27_scratch_${Math.random().toString(36).slice(2, 10)}`;
	await admin.unsafe(`CREATE DATABASE "${scratchDbName}"`);

	const scratchAdminUrl = new URL(adminUrl);
	scratchAdminUrl.pathname = `/${scratchDbName}`;
	const scratchAdmin = postgres(scratchAdminUrl.toString(), { max: 1 });

	// Minimal sessions/events tables carrying exactly the columns migration
	// 0006 indexes — enough for its CREATE INDEX statements to succeed (or,
	// for the Critical 2 test, to fail in a controlled way).
	await scratchAdmin.unsafe(`
		CREATE TABLE sessions (
			session_id text primary key, display_name text, cwd text,
			current_task text, notes text, agent_type text, status text,
			started_at text default now()::text, last_activity_at text default now()::text
		);
		CREATE TABLE events (
			id serial primary key, session_id text, event_type text,
			content text, raw_payload json, created_at text
		);
	`);

	return {
		admin,
		scratchAdmin,
		scratchDbName,
		cleanup: async () => {
			await scratchAdmin.end();
			await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
			await admin.end();
		},
	};
}

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

		// The cleanup at the end of this try block must run even when one of
		// this test's own assertions fails (a timing assertion especially —
		// "container I/O varies too much for a stable threshold" per the
		// comment below, so it can fail without the seeded data itself being
		// wrong). Skipping cleanup on a failed assertion leaves 200k+ rows
		// behind, which is exactly the bloat the comment at the bottom of
		// this block warns ingest-copilot.test.ts's unfiltered `DELETE FROM
		// events` about — a flaky assertion here used to cascade into an
		// unrelated file's hook timing out.
		try {
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
		} finally {
			// This suite's other files (e.g. ingest-copilot.test.ts) run an
			// unfiltered `DELETE FROM events` in beforeEach — leaving this
			// test's 200k rows behind turns that into a full-table delete on a
			// bloated table and can blow past their 5s hook timeout. Targeted
			// by session_id so it's a fast, indexed delete, not a table scan.
			// Runs even when an assertion above threw.
			await executeRows(
				db as unknown as import("./client.js").Db,
				sql`DELETE FROM events WHERE session_id = ${sid}`,
			);
			await executeRows(
				db as unknown as import("./client.js").Db,
				sql`DELETE FROM sessions WHERE session_id = ${sid}`,
			);
		}
	}, 30_000);

	// What this test does and does not claim.
	//
	// It claims: the migration created trigram indexes on all four searched
	// sessions columns, and the planner can answer the search predicate with a
	// BitmapOr over exactly those four indexes. To check that without depending
	// on the planner's cost estimates (which flip with table size, dead index
	// entries and machine settings), sequential and plain index scans are
	// switched off inside a transaction that is rolled back, so the only plan
	// that can win is the trigram one.
	//
	// It does not claim: that the planner picks the trigram plan on its own at
	// any particular table size. The default plan and timings are logged for
	// humans, with no assertion, because that choice is a cost-boundary call
	// that legitimately varies between runs and Postgres versions.
	//
	// (The events test above still compares timings with an index and without
	// one; if that ever flakes, give it the same treatment.)
	const SESSIONS_ROWS = 30_000;
	const SESSIONS_TRIGRAM_INDEXES = [
		"idx_sessions_display_name_trgm",
		"idx_sessions_cwd_trgm",
		"idx_sessions_current_task_trgm",
		"idx_sessions_notes_trgm",
	];

	test("the sessions search predicate can be served by all four trigram indexes (BitmapOr, no sequential scan)", async () => {
		const { getDb, initializeDatabase } = await import("./client.js");
		const { executeRows } = await import("./sql-helpers.js");
		await initializeDatabase();

		const db = getDb() as unknown as import("./client.js").Db;
		const marker = `agen27smk${crypto.randomUUID().replace(/-/g, "")}`;
		const timings: string[] = [];
		const timed = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
			const start = performance.now();
			try {
				return await run();
			} finally {
				timings.push(`${phase} ${((performance.now() - start) / 1000).toFixed(1)}s`);
			}
		};

		const explainSql = `
			EXPLAIN (FORMAT JSON)
			SELECT session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at
			FROM sessions
			WHERE (display_name ILIKE '%${marker}%' OR cwd ILIKE '%${marker}%' OR current_task ILIKE '%${marker}%' OR notes ILIKE '%${marker}%')
			ORDER BY started_at DESC
			LIMIT 50`;
		const planNodes = (rows: ExplainRow[]) => {
			const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
			expect(plan).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted defined above
			return collectNodes(plan!);
		};

		const conn = postgres(config.databaseUrl, { max: 1 });
		cleanupConnections.push(conn);
		try {
			await timed("seed", () =>
				executeRows(
					db,
					sql`
					INSERT INTO sessions (id, session_id, display_name, agent_type, status, cwd)
					SELECT
						gen_random_uuid()::text,
						'agen27-perf-sess-' || g,
						CASE WHEN g % 5000 = 0 THEN 'session ' || g || ' ' || ${marker} ELSE 'session ' || g END,
						'claude_code',
						'active',
						'/home/user/proj' || g
					FROM generate_series(1, ${SESSIONS_ROWS}) AS g
				`,
				),
			);
			await timed("analyze", () => executeRows(db, sql`ANALYZE sessions`));

			// Information only: what the planner chooses by itself right now.
			const defaultPlan = await timed("default-plan", async () =>
				planNodes((await conn.unsafe(explainSql)) as unknown as ExplainRow[]),
			);
			console.log(
				`[AGEN-27] sessions default plan at ${SESSIONS_ROWS} rows (not asserted): ${defaultPlan
					.map((n) => n["Index Name"] ?? n["Node Type"])
					.join(" > ")}`,
			);

			// The assertion: with the alternatives switched off (one connection, one
			// transaction, rolled back) the plan must use all four trigram indexes.
			let forcedNodes: ExplainNode[] = [];
			await conn.unsafe("BEGIN");
			try {
				await conn.unsafe("SET LOCAL enable_seqscan = off");
				await conn.unsafe("SET LOCAL enable_indexscan = off");
				await conn.unsafe("SET LOCAL enable_indexonlyscan = off");
				forcedNodes = planNodes((await conn.unsafe(explainSql)) as unknown as ExplainRow[]);
			} finally {
				await conn.unsafe("ROLLBACK");
			}

			const nodeTypes = forcedNodes.map((n) => n["Node Type"]);
			const indexNames = forcedNodes.map((n) => n["Index Name"]).filter(Boolean);
			expect(nodeTypes).not.toContain("Seq Scan");
			expect(nodeTypes).toContain("BitmapOr");
			for (const name of SESSIONS_TRIGRAM_INDEXES) {
				expect(indexNames, `plan should use ${name}`).toContain(name);
			}
		} finally {
			// Always runs: leaving rows behind makes unrelated files' unfiltered
			// deletes slower.
			await timed("cleanup", () =>
				executeRows(db, sql`DELETE FROM sessions WHERE session_id LIKE 'agen27-perf-sess-%'`),
			);
			console.log(
				`[AGEN-27] sessions trigram test at ${SESSIONS_ROWS} rows: ${timings.join(", ")}`,
			);
		}
	}, 60_000);

	test("gracefully skips the trigram index when pg_trgm can't be installed (simulated low-privilege role)", async () => {
		// A dedicated scratch DATABASE, not just a scratch table: pg_trgm is
		// installed per-database, and the shared `agentpulse_test` database
		// already has it (migration 0006 installed it for the real
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

		// The exact shape of migration 0006's two DO blocks, run as the
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

	// ── percy AGEN-27 review, High 3: automatic build gated on table size ──

	test("builds the trigram indexes automatically on a small/fresh table", async () => {
		const { scratchAdmin, cleanup } = await createScratchDb(config.databaseUrl);
		try {
			const statements = readMigration0006Statements();
			for (const statement of statements) {
				await scratchAdmin.unsafe(statement);
			}

			const idx = await scratchAdmin.unsafe(
				"SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%trgm' ORDER BY indexname",
			);
			expect(idx.length).toBe(10);
		} finally {
			await cleanup();
		}
	}, 30_000);

	test("skips the automatic index build and warns when events is already large (>100,000 rows, never analyzed)", async () => {
		const { scratchAdmin, cleanup } = await createScratchDb(config.databaseUrl);
		try {
			// percy re-verify (TB22, Critical): a never-analyzed table reports
			// pg_class.reltuples = -1 ("unknown"), not 0 — the real-world
			// trigger is a restored backup or a lagging autovacuum. Bulk-load
			// real rows with NO explicit ANALYZE, so reltuples is genuinely
			// -1 going into the migration; its own `EXECUTE 'ANALYZE events'`
			// (added this review) must be what makes the threshold check see
			// the true size, not a pre-existing accurate statistic.
			await scratchAdmin.unsafe(
				"INSERT INTO events (session_id, event_type, content, raw_payload, created_at) SELECT 's1', 'UserPromptSubmit', 'x', '{}'::json, now()::text FROM generate_series(1, 150000) g",
			);
			const preMigrationReltuples = await scratchAdmin.unsafe(
				"SELECT reltuples FROM pg_class WHERE oid = to_regclass('events')",
			);
			expect(Number(preMigrationReltuples[0]?.reltuples)).toBeLessThan(0);

			const statements = readMigration0006Statements();
			for (const statement of statements) {
				await scratchAdmin.unsafe(statement);
			}

			const idx = await scratchAdmin.unsafe(
				"SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%trgm'",
			);
			expect(idx.length).toBe(0);

			// The migration's own ANALYZE ran and correctly found the real
			// (large) row count — this isn't "the gate never fired because
			// stats were stale," it's "the gate correctly fired because the
			// migration itself refreshed the stats first."
			const postMigrationReltuples = await scratchAdmin.unsafe(
				"SELECT reltuples FROM pg_class WHERE oid = to_regclass('events')",
			);
			expect(Number(postMigrationReltuples[0]?.reltuples)).toBeGreaterThan(100000);
		} finally {
			await cleanup();
		}
	}, 30_000);

	test("still builds on a fresh empty table (reltuples reports 0, not -1, once the migration's own ANALYZE runs)", async () => {
		const { scratchAdmin, cleanup } = await createScratchDb(config.databaseUrl);
		try {
			const preMigrationReltuples = await scratchAdmin.unsafe(
				"SELECT reltuples FROM pg_class WHERE oid = to_regclass('events')",
			);
			expect(Number(preMigrationReltuples[0]?.reltuples)).toBeLessThan(0);

			const statements = readMigration0006Statements();
			for (const statement of statements) {
				await scratchAdmin.unsafe(statement);
			}

			const idx = await scratchAdmin.unsafe(
				"SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%trgm'",
			);
			expect(idx.length).toBe(10);

			const postMigrationReltuples = await scratchAdmin.unsafe(
				"SELECT reltuples FROM pg_class WHERE oid = to_regclass('events')",
			);
			expect(Number(postMigrationReltuples[0]?.reltuples)).toBe(0);
		} finally {
			await cleanup();
		}
	}, 30_000);

	// ── percy AGEN-27 review, Critical 2: a build failure is caught, not fatal ──

	test("an index-build failure is caught, a prior statement in the same transaction survives, and the transaction is not left aborted", async () => {
		const { scratchAdmin, cleanup } = await createScratchDb(config.databaseUrl);
		try {
			// Inject a failure: drop a column that migration 0006 indexes,
			// so its CREATE INDEX fails with a real, ordinary error
			// ("column does not exist") — the same class of
			// transient/config failure the EXCEPTION handler exists to
			// survive.
			await scratchAdmin.unsafe("ALTER TABLE sessions DROP COLUMN notes");

			const statements = readMigration0006Statements();
			expect(statements.length).toBe(2);
			const [extensionStatement, indexStatement] = statements as [string, string];

			// Run inside one explicit transaction, mirroring drizzle-orm's
			// migrator (every pending migration runs in one shared
			// transaction) — the property under test is specifically that
			// an uncaught error here would abort this whole transaction.
			await scratchAdmin.begin(async (tx) => {
				// A "prior statement in the same transaction": the
				// extension-install DO block, which precedes the failing
				// index-build DO block in the same migration file.
				await tx.unsafe(extensionStatement);

				// Must not throw — the EXCEPTION handler inside the DO
				// block must catch the column-does-not-exist error and
				// degrade to a WARNING instead.
				await tx.unsafe(indexStatement);

				// The transaction must not be left in Postgres's aborted
				// state (SQLSTATE 25P02, "current transaction is aborted,
				// commands ignored until end of transaction block") — an
				// uncaught error upstream would have left exactly that
				// state, and this next statement would fail with 25P02
				// instead of succeeding normally.
				const stillUsable = await tx.unsafe("SELECT 1 AS ok");
				expect(stillUsable[0]?.ok).toBe(1);
			});
			// The transaction committed successfully (scratchAdmin.begin
			// throws if the callback throws or the COMMIT fails) — the
			// "prior statement" (pg_trgm) really did survive to a commit,
			// not just to an uncommitted mid-transaction state.
			const ext = await scratchAdmin.unsafe(
				"SELECT 1 AS present FROM pg_extension WHERE extname = 'pg_trgm'",
			);
			expect(ext.length).toBe(1);

			// The specific index whose column was dropped never exists;
			// this is the "failure was real, not accidentally a no-op"
			// check.
			const idx = await scratchAdmin.unsafe(
				"SELECT 1 AS present FROM pg_indexes WHERE indexname = 'idx_sessions_notes_trgm'",
			);
			expect(idx.length).toBe(0);
		} finally {
			await cleanup();
		}
	}, 30_000);
});
