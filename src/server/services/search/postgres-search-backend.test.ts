/**
 * PostgresSearchBackend contract tests.
 *
 * The no-op contract tests (name, initialize, indexSession, removeSession,
 * indexEvent, removeEvent, rebuild) run unconditionally — they don't need a
 * live DB because the methods are no-ops by definition.
 *
 * The search() tests are gated by `describePostgresOnly` because they
 * require a real Postgres connection (AGENTPULSE_TEST_BACKEND=postgres).
 * In default SQLite CI they appear as skipped in the test output.
 *
 * Run with:
 *   AGENTPULSE_TEST_BACKEND=postgres DATABASE_URL=postgres://... bun test
 */

import { describe, expect, test } from "bun:test";
import { describePostgresOnly } from "../../test-utils/backend.js";
import { PostgresSearchBackend } from "./postgres-search-backend.js";
import { extractSnippet } from "./snippet.js";

// ── No-op contract (runs unconditionally) ─────────────────────────────────────

describe("PostgresSearchBackend — no-op contract", () => {
	test('name === "postgres-ilike"', () => {
		const backend = new PostgresSearchBackend();
		expect(backend.name).toBe("postgres-ilike");
	});

	test("initialize() returns without throwing", async () => {
		const backend = new PostgresSearchBackend();
		await expect(backend.initialize()).resolves.toBeUndefined();
	});

	test("indexSession() returns without throwing", async () => {
		const backend = new PostgresSearchBackend();
		await expect(
			backend.indexSession({
				sessionId: "s1",
				displayName: "brave-falcon",
				cwd: "/tmp/test",
				currentTask: "write tests",
				notes: "some notes",
				agentType: "claude_code",
				status: "active",
				lastActivityAt: new Date().toISOString(),
			}),
		).resolves.toBeUndefined();
	});

	test("removeSession() returns without throwing", async () => {
		const backend = new PostgresSearchBackend();
		await expect(backend.removeSession("s1")).resolves.toBeUndefined();
	});

	test("indexEvent() returns without throwing", async () => {
		const backend = new PostgresSearchBackend();
		await expect(
			backend.indexEvent({
				eventId: 42,
				sessionId: "s1",
				eventType: "UserPromptSubmit",
				text: "refactor the auth middleware",
				createdAt: new Date().toISOString(),
			}),
		).resolves.toBeUndefined();
	});

	test("removeEvent() returns without throwing", async () => {
		const backend = new PostgresSearchBackend();
		await expect(backend.removeEvent(42)).resolves.toBeUndefined();
	});

	test("rebuild() returns { sessionsIndexed: 0, eventsIndexed: 0, note: string }", async () => {
		const backend = new PostgresSearchBackend();
		const result = await backend.rebuild();
		expect(result.sessionsIndexed).toBe(0);
		expect(result.eventsIndexed).toBe(0);
		expect(typeof result.note).toBe("string");
		expect(result.note.length).toBeGreaterThan(0);
	});

	test("search() with empty query returns empty hits without touching DB", async () => {
		const backend = new PostgresSearchBackend();
		const result = await backend.search({ q: "" });
		expect(result.hits).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.backend).toBe("postgres-ilike");
	});

	test("search() with whitespace-only query returns empty hits", async () => {
		const backend = new PostgresSearchBackend();
		const result = await backend.search({ q: "   " });
		expect(result.hits).toEqual([]);
		expect(result.total).toBe(0);
	});
});

// ── snippet helper (runs unconditionally) ─────────────────────────────────────

describe("extractSnippet helper", () => {
	test("returns empty string when source is empty", () => {
		expect(extractSnippet("", "hello")).toBe("");
	});

	test("returns empty string when token not found", () => {
		expect(extractSnippet("no match here", "xyz")).toBe("");
	});

	test("wraps matched token in <mark> tags", () => {
		const result = extractSnippet("the quick brown fox", "quick");
		expect(result).toContain("<mark>quick</mark>");
	});

	test("is case-insensitive (preserves original casing in output)", () => {
		const result = extractSnippet("The Quick Brown Fox", "quick");
		expect(result).toContain("<mark>Quick</mark>");
	});

	test("adds leading ellipsis when match is not at start", () => {
		// Create a string where the token is far from the start
		const prefix = "a".repeat(50);
		const result = extractSnippet(`${prefix}token_here`, "token_here");
		expect(result.startsWith("…")).toBe(true);
	});

	test("adds trailing ellipsis when match is not at end", () => {
		const suffix = "z".repeat(50);
		const result = extractSnippet(`token_here${suffix}`, "token_here");
		expect(result.endsWith("…")).toBe(true);
	});

	test("no ellipsis when source fits within window", () => {
		const result = extractSnippet("short text with token", "token");
		expect(result.startsWith("…")).toBe(false);
		expect(result.endsWith("…")).toBe(false);
	});
});

// ── Mock-based execute shape regression (runs unconditionally) ────────────────
//
// Verifies that PostgresSearchBackend.searchSessions / searchEvents call
// executeRows() with a Drizzle SQL template object — NOT the broken
// `{ sql, params }` shape that would throw TypeError at runtime on postgres-js.
//
// The mock captures the query from whichever adapter path executeRows() takes:
//   - Postgres CI: db.execute(sqlTemplate) is called
//   - SQLite CI:   db.all(sqlTemplate) is called
// Both adapters receive a Drizzle SQL template. The assertion verifies the
// template has a `getSQL()` method (Drizzle's runtime contract), ruling out
// the broken `{ sql: string, params: [] }` object shape.

describe("PostgresSearchBackend — execute shape (mock-based, unconditional)", () => {
	// percy AGEN-27 review (TB22): searchSessions/searchEvents no longer call
	// executeRows()/db.execute() — they go through executeUnprepared(),
	// which calls db.dialect.sqlToQuery() (to get { sql, params } from the
	// Drizzle SQL template) and then db.$client.unsafe(text, params, {
	// prepare: false }) directly, so prepared-statement caching never
	// engages for these two queries. This mock asserts that exact shape:
	// a real Drizzle SQL template goes into sqlToQuery, and unsafe() gets a
	// string + array + explicit prepare:false, never the broken
	// `{ sql, params }`-as-query shape an earlier campaign's bug produced.
	function buildMockDb(capture: {
		query?: unknown;
		text?: string;
		params?: unknown;
		opts?: unknown;
	}) {
		// Shared by both direct-call sites: searchSessions calls
		// `$client.unsafe()` directly (executeUnprepared()); searchEvents
		// (percy AGEN-27 review, TB26) calls `$client.begin(cb)` and runs
		// its query via the transaction handle `cb` receives instead. Both
		// paths route through this one `unsafe` so the capture logic is
		// shared. Plan A issues a `SET LOCAL statement_timeout = ...` call
		// before the real query — filtered out of the capture so
		// `capture.text`/`capture.params` reflect the actual query, not the
		// GUC-setting call ahead of it.
		const unsafe = (text: string, params: unknown, opts: unknown) => {
			if (!text.startsWith("SET LOCAL")) {
				capture.text = text;
				capture.params = params;
				capture.opts = opts;
			}
			return Promise.resolve([] as unknown[]);
		};
		return {
			dialect: {
				sqlToQuery: (q: unknown) => {
					capture.query = q;
					return { sql: "SELECT 1", params: [] };
				},
			},
			$client: {
				unsafe,
				begin: async (cb: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => cb({ unsafe }),
			},
		};
	}

	test("searchSessions calls dialect.sqlToQuery with a Drizzle SQL template, then $client.unsafe with prepare:false", async () => {
		const capture: { query?: unknown; text?: string; params?: unknown; opts?: unknown } = {};
		const mockDb = buildMockDb(capture);

		const backend = new PostgresSearchBackend(
			mockDb as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				typeof import("../../db/schema/index.js")
			>,
		);

		await backend.search({ q: "hello", kinds: ["session"] });

		expect(capture.query).toBeDefined();
		expect(typeof capture.query).toBe("object");
		// Drizzle SQL templates have a `getSQL()` method; a plain
		// `{ sql, params }` object (the earlier campaign's broken shape) does not.
		// biome-ignore lint/suspicious/noExplicitAny: testing internal drizzle shape
		expect(typeof (capture.query as any).getSQL).toBe("function");

		expect(typeof capture.text).toBe("string");
		expect(Array.isArray(capture.params)).toBe(true);
		expect(capture.opts).toEqual({ prepare: false });
	});

	test("searchEvents calls dialect.sqlToQuery with a Drizzle SQL template, then $client.unsafe with prepare:false", async () => {
		const capture: { query?: unknown; text?: string; params?: unknown; opts?: unknown } = {};
		const mockDb = buildMockDb(capture);

		const backend = new PostgresSearchBackend(
			mockDb as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				typeof import("../../db/schema/index.js")
			>,
		);

		await backend.search({ q: "world", kinds: ["event"] });

		expect(capture.query).toBeDefined();
		expect(typeof capture.query).toBe("object");
		// biome-ignore lint/suspicious/noExplicitAny: testing internal drizzle shape
		expect(typeof (capture.query as any).getSQL).toBe("function");

		expect(typeof capture.text).toBe("string");
		expect(Array.isArray(capture.params)).toBe(true);
		expect(capture.opts).toEqual({ prepare: false });
	});
});

// ── Postgres-only: live DB search tests ───────────────────────────────────────

describePostgresOnly(
	"PostgresSearchBackend — live Postgres search (AGENTPULSE_TEST_BACKEND=postgres)",
	() => {
		function uid(prefix: string) {
			return `${prefix}-${crypto.randomUUID()}`;
		}

		test("search() returns hits for sessions matching display_name", async () => {
			// Regression for a real production bug this test suite never caught:
			// the session-search query's `ORDER BY created_at` referenced a
			// column that doesn't exist on `sessions` (which has `started_at` /
			// `last_activity_at`, not `created_at`) — every session-kind search
			// with a non-empty query 500'd on a real Postgres backend. The stub
			// `expect(true).toBe(true)` this test replaces never actually ran a
			// query, so it passed regardless. Caught only when
			// search-agent-type-filter.test.ts's copilot_cli case exercised
			// GET /search?q=... end-to-end against a real Postgres container.
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const { sessions } = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			await initializeDatabase();

			const sid = uid("pgsearch");
			const token = uid("tok").replace(/-/g, "");

			await getDb()
				.insert(sessions)
				.values({
					sessionId: sid,
					displayName: `session ${token}`,
					agentType: "claude_code",
					status: "active",
				})
				.execute();

			const backend = new PostgresSearchBackend();
			const result = await backend.search({ q: token, kinds: ["session"] });

			expect(result.backend).toBe("postgres-ilike");
			expect(result.hits.length).toBe(1);
			expect(result.hits[0]?.kind).toBe("session");
			expect(result.hits[0]?.sessionId).toBe(sid);
			expect(result.hits[0]?.sessionDisplayName).toBe(`session ${token}`);
		});

		test("agentType filter restricts results via session join", async () => {
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const { sessions } = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			await initializeDatabase();

			const token = uid("tok").replace(/-/g, "");
			const claudeSid = uid("pgsearch-claude");
			const codexSid = uid("pgsearch-codex");

			await getDb()
				.insert(sessions)
				.values([
					{
						sessionId: claudeSid,
						displayName: `agentfilter ${token}`,
						agentType: "claude_code",
						status: "active",
					},
					{
						sessionId: codexSid,
						displayName: `agentfilter ${token}`,
						agentType: "codex_cli",
						status: "active",
					},
				])
				.execute();

			const backend = new PostgresSearchBackend();
			const result = await backend.search({
				q: token,
				kinds: ["session"],
				agentType: "codex_cli",
			});

			expect(result.hits.map((h) => h.sessionId)).toEqual([codexSid]);
		});

		// ── AGEN-27: event-type restriction, pagination order, SQLite parity ──

		test("excludes non-indexed event types (e.g. PreToolUse) even when the text matches", async () => {
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const { sessions, events } = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			await initializeDatabase();

			const sid = uid("pgsearch-excl");
			const token = uid("tok").replace(/-/g, "");

			await getDb()
				.insert(sessions)
				.values({ sessionId: sid, agentType: "claude_code", status: "active" })
				.execute();

			await getDb()
				.insert(events)
				.values([
					{
						sessionId: sid,
						eventType: "UserPromptSubmit",
						content: `indexed hit ${token}`,
						rawPayload: { prompt: `indexed hit ${token}` },
					},
					{
						// PreToolUse is not in FTS_INDEXED_EVENT_TYPES — must never
						// surface in search results, matching text or not.
						sessionId: sid,
						eventType: "PreToolUse",
						content: `non-indexed hit ${token}`,
						rawPayload: {},
					},
				])
				.execute();

			const backend = new PostgresSearchBackend();
			const result = await backend.search({ q: token, kinds: ["event"], sessionId: sid });

			expect(result.hits.length).toBe(1);
			expect(result.hits[0]?.eventType).toBe("UserPromptSubmit");
		});

		test("orders events by created_at DESC, id DESC (same-timestamp tiebreak)", async () => {
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const { sessions, events } = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			await initializeDatabase();

			const sid = uid("pgsearch-order");
			const token = uid("tok").replace(/-/g, "");
			const sameTimestamp = "2026-01-01 00:00:00";

			await getDb()
				.insert(sessions)
				.values({ sessionId: sid, agentType: "claude_code", status: "active" })
				.execute();

			// Three rows sharing one created_at value, inserted out of id order,
			// so a correct tiebreak can only come from `id DESC`, not insertion
			// order or timestamp alone.
			const inserted = await getDb()
				.insert(events)
				.values([
					{
						sessionId: sid,
						eventType: "UserPromptSubmit",
						content: `order ${token} a`,
						rawPayload: { prompt: `order ${token} a` },
						createdAt: sameTimestamp,
					},
					{
						sessionId: sid,
						eventType: "UserPromptSubmit",
						content: `order ${token} b`,
						rawPayload: { prompt: `order ${token} b` },
						createdAt: sameTimestamp,
					},
					{
						sessionId: sid,
						eventType: "UserPromptSubmit",
						content: `order ${token} c`,
						rawPayload: { prompt: `order ${token} c` },
						createdAt: sameTimestamp,
					},
				])
				.returning({ id: events.id })
				.execute();

			const ids = inserted.map((r) => r.id);
			expect(ids.length).toBe(3);
			const expectedOrder = [...ids].sort((a, b) => b - a);

			const backend = new PostgresSearchBackend();
			const result = await backend.search({
				q: token,
				kinds: ["event"],
				sessionId: sid,
				mode: "or",
			});

			expect(result.hits.map((h) => h.eventId)).toEqual(expectedOrder);
		});

		test("result parity with the SQLite FTS backend: same hit set for the same fixture (score/ranking excluded)", async () => {
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const { sessions, events } = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			const { SqliteFtsBackend } = await import("./sqlite-fts-backend.js");
			const { FTS_BOOTSTRAP_SQL } = await import("../../db/fts-ddl.js");
			const { Database } = await import("bun:sqlite");
			await initializeDatabase();

			const sid = uid("pgsearch-parity");
			const token = uid("tok").replace(/-/g, "");

			// Fixture: one indexed row matching the token via `prompt` (should
			// hit on both dialects), one indexed row matching only via a
			// secondary raw_payload field (`why`) while `content` holds
			// unrelated text — the case that rules out a single-coalesced-text
			// index (see drizzle/postgres/0005_agen27_pg_trgm_search_index.sql)
			// — and one non-indexed row that must be excluded on both sides.
			const fixture = [
				{
					eventType: "UserPromptSubmit",
					content: `${token} prompt hit`,
					rawPayload: { prompt: `${token} prompt hit` },
				},
				{
					eventType: "AiProposal",
					content: "unrelated proposal text",
					rawPayload: { proposal_id: "p1", why: `${token} why hit` },
				},
				{
					eventType: "PreToolUse",
					content: `${token} noise, must be excluded`,
					rawPayload: {},
				},
			];

			// ── Postgres side (real app tables) ──
			await getDb()
				.insert(sessions)
				.values({ sessionId: sid, agentType: "claude_code", status: "active" })
				.execute();
			await getDb()
				.insert(events)
				.values(fixture.map((f) => ({ sessionId: sid, ...f })))
				.execute();

			const pgBackend = new PostgresSearchBackend();
			const pgResult = await pgBackend.search({ q: token, kinds: ["event"], sessionId: sid });

			// ── SQLite side (isolated in-memory fixture; independent of the
			// process-wide dialect, which is "postgres" for this test run) ──
			const sqliteDb = new Database(":memory:");
			sqliteDb.exec(`
				CREATE TABLE sessions (
					session_id TEXT PRIMARY KEY, display_name TEXT, cwd TEXT,
					current_task TEXT, notes TEXT, agent_type TEXT NOT NULL,
					status TEXT NOT NULL, last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
			`);
			sqliteDb.exec(`
				CREATE TABLE events (
					id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
					event_type TEXT NOT NULL, content TEXT, raw_payload TEXT NOT NULL DEFAULT '{}',
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
			`);
			sqliteDb.exec(FTS_BOOTSTRAP_SQL);
			sqliteDb
				.prepare("INSERT INTO sessions (session_id, agent_type, status) VALUES (?, ?, ?)")
				.run(sid, "claude_code", "active");
			const insertEvent = sqliteDb.prepare(
				"INSERT INTO events (session_id, event_type, content, raw_payload) VALUES (?, ?, ?, ?)",
			);
			for (const f of fixture) {
				insertEvent.run(sid, f.eventType, f.content, JSON.stringify(f.rawPayload));
			}

			const sqliteBackend = new SqliteFtsBackend(sqliteDb);
			const sqliteResult = await sqliteBackend.search({
				q: token,
				kinds: ["event"],
				sessionId: sid,
			});
			sqliteDb.close();

			// Compare by event_type set, not score/rank/id (dialect-specific).
			const pgTypes = pgResult.hits.map((h) => h.eventType).sort();
			const sqliteTypes = sqliteResult.hits.map((h) => h.eventType).sort();

			expect(pgTypes).toEqual(["AiProposal", "UserPromptSubmit"]);
			expect(sqliteTypes).toEqual(["AiProposal", "UserPromptSubmit"]);
			expect(pgTypes).toEqual(sqliteTypes);
		});

		// ── percy AGEN-27 review (TB26): adaptive two-plan searchEvents ──────
		//
		// Supersedes the TB22/TB24 "5-bucket selectivity matrix" wall-clock
		// test and the TB25 EXPLAIN-plan-shape design (never committed —
		// investigation for it found the actual defect this section now
		// tests for). History, for context on why this is shaped the way
		// it is:
		//
		//   TB17: MATERIALIZED CTE fence — correct for a rare term,
		//   catastrophic for a common one (0.18ms -> 1.8s at 1M rows).
		//
		//   TB22: removed the fence; searchEvents/searchSessions run
		//   unprepared (prepare: false) instead, so common/short terms
		//   benefit from early-LIMIT exactly like an ad hoc query would.
		//
		//   TB25 investigation: EXPLAIN ANALYZE against a worst-case
		//   fixture (identical created_at across 1M rows, so a genuinely
		//   *unique* match sits at the very end of
		//   `ORDER BY created_at DESC, id DESC` scan order — not percy's
		//   original rare-term fixture, which had 143 spread-out matches
		//   and let early-LIMIT succeed by luck) found the planner *never*
		//   picks the trigram BitmapOr plan for this query shape, at any
		//   selectivity: Postgres's ILIKE '%term%' selectivity estimator
		//   can't know a literal substring is rare vs. common, so it always
		//   prefers walking idx_events_created_at_id. That's fast
		//   (0.15-3ms) for every bucket except a genuinely rare/unique one,
		//   where it degrades to a near-full-table scan: measured
		//   892-926ms at 1M rows, and worse as `events` grows — forcing
		//   the planner off that index on the same data proved the trigram
		//   plan is available and ~2000x faster (0.45ms).
		//
		//   TB26 (this section): searchEvents now runs Plan A (the TB22
		//   query, unprepared, inside a transaction with
		//   `SET LOCAL statement_timeout = '150ms'`) and, only if Plan A
		//   is canceled by that timeout (SQLSTATE 57014), re-runs the
		//   identical query in a *fresh* transaction with
		//   `enable_indexscan`/`enable_indexonlyscan` off (Plan B), forcing
		//   the provably-correct trigram path. See
		//   executeEventsQueryWithFallback()'s doc comment in
		//   postgres-search-backend.ts for the full design.
		test("adaptive two-plan strategy: a unique/rare term falls back to Plan B and returns the correct result; common and short terms stay on Plan A", async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const schema = await import("../../db/schema/index.js");
			const { config } = await import("../../config.js");
			const { sql } = await import("drizzle-orm");
			const { executeRows } = await import("../../db/sql-helpers.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			type PgDb = import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>;
			await initializeDatabase();

			// One dedicated connection for the whole matrix — a pooled
			// connection could silently route calls to different
			// physical backends.
			const pgClient = postgres(config.databaseUrl, { max: 1 });
			const dedicatedDb: PgDb = drizzle(pgClient, { schema });
			const sid = uid("pgsearch-buckets");
			// >= 300k floor per TB26's spec. 2M (not 1M) for margin: when
			// this test runs standalone right after container start, 1M
			// rows reliably pushed Plan A past its 150ms timeout (~900ms
			// cold-cache scan, per the TB25 investigation). Running as
			// part of the full file (after several earlier tests' bulk
			// inserts/deletes/VACUUMs have already warmed shared_buffers
			// and the OS page cache for `events`) occasionally let a
			// fully-cached 1M-row scan finish under 150ms on pure CPU cost
			// alone — Plan A legitimately "won its bet," not a bug, but it
			// made the fallback-was-taken assertion flaky. Doubling the
			// row count roughly doubles that same CPU-bound cost even in
			// the fully-cached case, restoring comfortable margin above
			// 150ms without relying on cold-cache I/O at all.
			const ROW_COUNT = 2_000_000;
			const PERF_TESTS = process.env.AGENTPULSE_PERF_TESTS === "1";

			try {
				const backend = new PostgresSearchBackend(dedicatedDb);

				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`INSERT INTO sessions (id, session_id, agent_type, status) VALUES (gen_random_uuid()::text, ${sid}, 'claude_code', 'active')`,
				);

				// Every row is UserPromptSubmit (an indexed type), identical
				// created_at (matches the real fixture's own bulk-insert
				// shape — every row's created_at comes from the same
				// statement's `now()`, frozen for the whole statement) so
				// ORDER BY ties break purely on `id DESC` — meaning
				// RAREBKT (g=1, the smallest id) sits at the very *end* of
				// scan order: the genuine worst case, not percy's original
				// spread-out fixture. Four independent markers, each gated
				// by its own modulo so the buckets don't interfere: rare
				// (row 1 only), 10% (g % 10 = 0), 50% (g % 2 = 0), 90%
				// (the complement of the 10% bucket). The 1-2 char bucket
				// needs no marker — every row's base text already contains
				// "re" (from "refactor").
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`
							INSERT INTO events (session_id, event_type, content, raw_payload, created_at)
							SELECT
								${sid},
								'UserPromptSubmit',
								'refactor payload ' || g
									|| (CASE WHEN g = 1 THEN ' RAREBKT' ELSE '' END)
									|| (CASE WHEN g % 10 = 0 THEN ' TENBKT' ELSE '' END)
									|| (CASE WHEN g % 2 = 0 THEN ' FIFTYBKT' ELSE '' END)
									|| (CASE WHEN g % 10 != 0 THEN ' NINETYBKT' ELSE '' END),
								json_build_object(
									'prompt',
									'refactor payload ' || g
										|| (CASE WHEN g = 1 THEN ' RAREBKT' ELSE '' END)
										|| (CASE WHEN g % 10 = 0 THEN ' TENBKT' ELSE '' END)
										|| (CASE WHEN g % 2 = 0 THEN ' FIFTYBKT' ELSE '' END)
										|| (CASE WHEN g % 10 != 0 THEN ' NINETYBKT' ELSE '' END)
								),
								now()::text
							FROM generate_series(1, ${ROW_COUNT}) AS g
						`,
				);
				// ANALYZE (via VACUUM ANALYZE, not just ANALYZE — this test
				// shares `events` with every other test in this suite,
				// several of which insert-then-delete rows of their own,
				// and VACUUM reclaims that dead-tuple bloat so timing/plan
				// choice reflects this test's own live rows, not a
				// neighbor's leftover churn) is required: the reltuples
				// migration-0006 gate (percy AGEN-27 review, TB22) and the
				// planner's own row-count estimates both need real,
				// up-to-date statistics — an un-ANALYZEd table reports
				// reltuples = -1 ("unknown"), not 0.
				await pgClient.unsafe("VACUUM (ANALYZE) events");
				// Prime the OS/Postgres page cache: right after a large bulk
				// insert, the freshly-written pages aren't cached yet, and a
				// full-table read (checkpoint I/O, cold pages) can dominate
				// the *first* query's timing regardless of which plan it
				// uses — a seeding artifact, not a planner regression.
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`SELECT count(*) FROM events WHERE session_id = ${sid}`,
				);

				const buckets: Array<{
					name: string;
					term: string;
					expectFallback: boolean;
				}> = [
					{
						name: "rare (1 row, unique, worst-case scan position)",
						term: "RAREBKT",
						expectFallback: true,
					},
					{ name: "~10%", term: "TENBKT", expectFallback: false },
					{ name: "~50%", term: "FIFTYBKT", expectFallback: false },
					{ name: "~90%", term: "NINETYBKT", expectFallback: false },
					{ name: '1-2 char ("re")', term: "re", expectFallback: false },
				];

				// Worst-case wall-clock: Plan A's own 150ms statement_timeout
				// bounds the slow path, and Plan B's forced trigram scan
				// measured ~0.45ms — so total worst-case latency (including
				// the fallback) should stay comfortably under a few hundred
				// ms regardless of which bucket. Opt-in only
				// (AGENTPULSE_PERF_TESTS=1, the existing D32/D33 pattern) —
				// correctness and the fallback flag are asserted
				// unconditionally below; only the wall-clock number needs
				// the shared-host-noise escape hatch.
				const SANE_BOUND_MS = 250;
				const timings: Record<string, number> = {};

				for (const bucket of buckets) {
					// Warm up more than 8 times through the real production
					// call path before the timed call.
					for (let i = 0; i < 9; i++) {
						await backend.search({ q: bucket.term, kinds: ["event"], sessionId: sid });
					}
					const start = performance.now();
					const result = await backend.search({
						q: bucket.term,
						kinds: ["event"],
						sessionId: sid,
					});
					const elapsedMs = performance.now() - start;
					timings[bucket.name] = elapsedMs;

					expect(result.hits.length).toBeGreaterThan(0);
					if (bucket.term === "RAREBKT") {
						// The correct single result, not just "some" result.
						expect(result.hits.length).toBe(1);
						expect(result.hits[0]?.snippet).toContain("RAREBKT");
					}
					expect(result.debug?.postgresEventsUsedFallback).toBe(bucket.expectFallback);

					if (PERF_TESTS) {
						expect(elapsedMs).toBeLessThan(SANE_BOUND_MS);
					}
				}

				console.log(
					`[AGEN-27 TB26] two-plan search timings at ${ROW_COUNT} rows (wall-clock bound checked only under AGENTPULSE_PERF_TESTS=1):`,
					JSON.stringify(timings),
				);
			} finally {
				// Cleanup — see pg-trgm-search-index.test.ts for why leaving
				// leftover rows behind pollutes later tests' unfiltered deletes.
				// Run on the shared pool (getDb()), not the dedicated
				// connection, since it's about to close.
				await executeRows(
					getDb() as unknown as import("../../db/client.js").Db,
					sql`DELETE FROM events WHERE session_id = ${sid}`,
				).catch(() => {});
				await executeRows(
					getDb() as unknown as import("../../db/client.js").Db,
					sql`DELETE FROM sessions WHERE session_id = ${sid}`,
				).catch(() => {});
				await pgClient.end();
			}
		}, 120_000);

		test("pagination parity: Plan A and Plan B agree on page 2 for a mid-selectivity term", async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const { getDb, initializeDatabase } = await import("../../db/client.js");
			const schema = await import("../../db/schema/index.js");
			const { config } = await import("../../config.js");
			const { sql } = await import("drizzle-orm");
			const { executeRows } = await import("../../db/sql-helpers.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			type PgDb = import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>;
			await initializeDatabase();

			const pgClient = postgres(config.databaseUrl, { max: 1 });
			const dedicatedDb: PgDb = drizzle(pgClient, { schema });
			const sid = uid("pgsearch-pagination");
			const ROW_COUNT = 500_000;

			try {
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`INSERT INTO sessions (id, session_id, agent_type, status) VALUES (gen_random_uuid()::text, ${sid}, 'claude_code', 'active')`,
				);
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`
						INSERT INTO events (session_id, event_type, content, raw_payload, created_at)
						SELECT
							${sid},
							'UserPromptSubmit',
							'refactor payload ' || g || (CASE WHEN g % 2 = 0 THEN ' MIDBKT' ELSE '' END),
							json_build_object(
								'prompt',
								'refactor payload ' || g || (CASE WHEN g % 2 = 0 THEN ' MIDBKT' ELSE '' END)
							),
							now()::text
						FROM generate_series(1, ${ROW_COUNT}) AS g
					`,
				);
				await pgClient.unsafe("VACUUM (ANALYZE) events");

				// Plan A: the normal path. A ~50%-selectivity term never
				// naturally times out, so this genuinely exercises Plan A.
				const planA = new PostgresSearchBackend(dedicatedDb);
				const planAResult = await planA.search({
					q: "MIDBKT",
					kinds: ["event"],
					sessionId: sid,
					limit: 10,
					offset: 10,
				});

				// Plan B: forced via the test-only constructor hook, through
				// the exact same query-building code (searchEvents) — no
				// query text is duplicated here, avoiding the query-shape
				// drift risk the TB25 investigation surfaced.
				const planB = new PostgresSearchBackend(dedicatedDb, { forcePlanBForTesting: true });
				const planBResult = await planB.search({
					q: "MIDBKT",
					kinds: ["event"],
					sessionId: sid,
					limit: 10,
					offset: 10,
				});

				expect(planAResult.debug?.postgresEventsUsedFallback).toBe(false);
				expect(planBResult.debug?.postgresEventsUsedFallback).toBe(true);

				const planAIds = planAResult.hits.map((h) => h.eventId);
				const planBIds = planBResult.hits.map((h) => h.eventId);
				expect(planAIds.length).toBe(10);
				expect(planAIds).toEqual(planBIds);
			} finally {
				await executeRows(
					getDb() as unknown as import("../../db/client.js").Db,
					sql`DELETE FROM events WHERE session_id = ${sid}`,
				).catch(() => {});
				await executeRows(
					getDb() as unknown as import("../../db/client.js").Db,
					sql`DELETE FROM sessions WHERE session_id = ${sid}`,
				).catch(() => {});
				await pgClient.end();
			}
		}, 60_000);

		test("SET LOCAL from Plan B does not leak onto a later pooled connection", async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const { initializeDatabase } = await import("../../db/client.js");
			const schema = await import("../../db/schema/index.js");
			const { config } = await import("../../config.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			type PgDb = import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>;
			await initializeDatabase();

			const pgClient = postgres(config.databaseUrl, { max: 1 });
			const dedicatedDb: PgDb = drizzle(pgClient, { schema });

			try {
				// Force Plan B (sets enable_indexscan/enable_indexonlyscan
				// off and a custom statement_timeout, all SET LOCAL, inside
				// a transaction) — an empty result set is fine, this test
				// only cares about GUC state after the transaction ends.
				const backend = new PostgresSearchBackend(dedicatedDb, { forcePlanBForTesting: true });
				await backend.search({ q: "anything", kinds: ["event"] });

				// A fresh query on the SAME underlying client, outside any
				// transaction — Postgres resets every LOCAL GUC at
				// COMMIT/ROLLBACK regardless of connection pooling, so this
				// must read back to session defaults.
				const [indexscan] = await pgClient.unsafe("SHOW enable_indexscan", [], { prepare: false });
				const [indexonlyscan] = await pgClient.unsafe("SHOW enable_indexonlyscan", [], {
					prepare: false,
				});
				const [timeout] = await pgClient.unsafe("SHOW statement_timeout", [], { prepare: false });

				expect((indexscan as unknown as { enable_indexscan: string }).enable_indexscan).toBe("on");
				expect(
					(indexonlyscan as unknown as { enable_indexonlyscan: string }).enable_indexonlyscan,
				).toBe("on");
				expect((timeout as unknown as { statement_timeout: string }).statement_timeout).toBe("0");
			} finally {
				await pgClient.end();
			}
		}, 30_000);

		test("a non-timeout error (schema mismatch) still propagates unchanged, not swallowed or silently retried", async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const schema = await import("../../db/schema/index.js");
			const { PostgresSearchBackend } = await import("./postgres-search-backend.js");
			type PgDb = import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>;

			// A scratch DATABASE (not a scratch table in the shared test DB)
			// with `sessions.cwd` intentionally omitted — searchEvents'
			// query selects `s.cwd AS session_cwd`, so any search against
			// this schema fails at parse time with a real, non-57014
			// SQLSTATE (42703 undefined_column), regardless of whether any
			// row would have matched. Isolated in its own database so this
			// deliberately-broken schema can never contaminate the shared
			// `agentpulse_test` database other tests in this file depend on.
			const { config } = await import("../../config.js");
			const admin = postgres(config.databaseUrl, { max: 1 });
			const scratchDbName = `agen27_tb26_scratch_${Math.random().toString(36).slice(2, 10)}`;
			await admin.unsafe(`CREATE DATABASE "${scratchDbName}"`);
			const scratchUrl = new URL(config.databaseUrl);
			scratchUrl.pathname = `/${scratchDbName}`;
			const scratchClient = postgres(scratchUrl.toString(), { max: 1 });

			try {
				await scratchClient.unsafe(`
					CREATE TABLE sessions (
						session_id text primary key,
						display_name text
					);
					CREATE TABLE events (
						id serial primary key,
						session_id text references sessions(session_id),
						event_type text,
						content text,
						raw_payload json,
						created_at text
					);
				`);
				await scratchClient.unsafe(
					`INSERT INTO sessions (session_id, display_name) VALUES ('s1', 'test session')`,
				);
				await scratchClient.unsafe(
					`INSERT INTO events (session_id, event_type, content, raw_payload, created_at) VALUES ('s1', 'UserPromptSubmit', 'refactor payload', '{"prompt":"refactor payload"}', now()::text)`,
				);

				const scratchDb: PgDb = drizzle(scratchClient, { schema });
				const backend = new PostgresSearchBackend(scratchDb);

				let caught: unknown;
				try {
					await backend.search({ q: "refactor", kinds: ["event"] });
				} catch (err) {
					caught = err;
				}

				expect(caught).toBeDefined();
				const code = (caught as { code?: string } | undefined)?.code;
				expect(code).not.toBe("57014");
				expect(code).toBe("42703");
			} finally {
				await scratchClient.end();
				await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
				await admin.end();
			}
		}, 30_000);
	},
);
