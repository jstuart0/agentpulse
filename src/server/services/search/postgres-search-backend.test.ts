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
		return {
			dialect: {
				sqlToQuery: (q: unknown) => {
					capture.query = q;
					return { sql: "SELECT 1", params: [] };
				},
			},
			$client: {
				unsafe: (text: string, params: unknown, opts: unknown) => {
					capture.text = text;
					capture.params = params;
					capture.opts = opts;
					return Promise.resolve([] as unknown[]);
				},
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

		// ── percy AGEN-27 review (TB22 re-verify): 5-bucket selectivity matrix ──
		//
		// Replaces the MATERIALIZED-CTE-fence test TB17 added. The fence
		// forced Postgres to fully materialize every WHERE-matching row
		// before LIMIT — correct for a rare term, catastrophic for a common
		// one (percy measured a 50%-selectivity term at 1M rows regress
		// 0.18ms -> 1.8s, ~50MB of temp spilled). TB22 removed the fence:
		// searchEvents/searchSessions now run with server-side prepared
		// statements disabled (executeUnprepared(), prepare: false) instead,
		// so every execution sees the real bound ILIKE pattern — rare terms
		// use the trigram indexes, common terms benefit from early-LIMIT
		// (walk in sort order, stop the instant enough matches are found)
		// exactly like an ad hoc query always would.
		//
		// Five buckets across the selectivity spectrum, all through the real
		// production path (PostgresSearchBackend.search()) on one dedicated
		// connection, each warmed up more than 8 times before the timed call:
		// a rare term (1 row), ~10%, ~50%, ~90%, and a 1-2 char term (too
		// short for pg_trgm to index at all — trigram extraction needs 3+
		// characters — so this is the pure early-LIMIT case).
		test("stays fast across the selectivity spectrum: rare, 10%, 50%, 90%, and a 1-2 char term", async () => {
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
			const ROW_COUNT = 1_000_000;

			try {
				const backend = new PostgresSearchBackend(dedicatedDb);

				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`INSERT INTO sessions (id, session_id, agent_type, status) VALUES (gen_random_uuid()::text, ${sid}, 'claude_code', 'active')`,
				);

				// Every row is UserPromptSubmit (an indexed type) so bucket
				// percentages are exact fractions of ROW_COUNT, not diluted
				// by non-indexed noise rows. Four independent markers, each
				// gated by its own modulo so the buckets don't interfere:
				// rare (row 1 only), 10% (g % 10 = 0), 50% (g % 2 = 0), 90%
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
				// VACUUM (not just ANALYZE): this test shares the `events`
				// table with every other test in this suite, several of
				// which insert-then-delete 200k-1M rows of their own —
				// dead tuples autovacuum hasn't caught up to yet bloat the
				// table's physical size beyond this test's own 1M live
				// rows. VACUUM reclaims that space so timing reflects this
				// test's own data, not a neighbor's leftover churn. (The
				// dominant cause of the flaky multi-hundred-ms timings
				// this comment used to describe was actually the test
				// Postgres container's default shared-memory size
				// starving parallel-plan query workers under sustained
				// load — Docker's default `--shm-size` (~64MB) surfaces
				// as "could not resize shared memory segment: No space
				// left on device"; fixed by running the container with
				// `--shm-size=1gb` (see .github/workflows/ci.yml's
				// test-postgres job). VACUUM is cheap, real hygiene, and
				// kept regardless of that fix.)
				await pgClient.unsafe("VACUUM (ANALYZE) events");
				// Prime the OS/Postgres page cache: right after a 1M-row bulk
				// insert, the freshly-written pages aren't cached yet, and a
				// full-table read (checkpoint I/O, cold pages) can dominate
				// the *first* query's timing regardless of which plan it
				// uses — a seeding artifact, not a planner regression. A
				// full sequential read here pulls every page in once, so
				// the timed measurements below reflect query-plan cost, not
				// cold-cache I/O.
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`SELECT count(*) FROM events WHERE session_id = ${sid}`,
				);

				const buckets: Array<{ name: string; term: string; expectHits: boolean }> = [
					{ name: "rare (1 row)", term: "RAREBKT", expectHits: true },
					{ name: "~10%", term: "TENBKT", expectHits: true },
					{ name: "~50%", term: "FIFTYBKT", expectHits: true },
					{ name: "~90%", term: "NINETYBKT", expectHits: true },
					{ name: '1-2 char ("re")', term: "re", expectHits: true },
				];

				// Measured 2-4ms per bucket, consistently, once the test
				// Postgres container has enough shared memory for
				// parallel-plan queries (`--shm-size` — Docker's tiny
				// default starves DSM allocation for parallel workers
				// under the sustained query load this suite generates,
				// which produced multi-hundred-ms noise unrelated to
				// planning; not this test's concern once the container is
				// sized correctly). The true regression this guards
				// against (the removed MATERIALIZED fence on a common
				// term) measured 480ms-1.8s — orders of magnitude above
				// 50ms.
				const SANE_BOUND_MS = 50;
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

					if (bucket.expectHits) {
						expect(result.hits.length).toBeGreaterThan(0);
					}
					expect(elapsedMs).toBeLessThan(SANE_BOUND_MS);
				}

				// percy asked for the 5-bucket numbers in the report — this
				// is the source of truth.
				console.log(
					`[AGEN-27 TB22] 5-bucket selectivity matrix at ${ROW_COUNT} rows:`,
					JSON.stringify(timings),
				);
			} finally {
				// Cleanup — see pg-trgm-search-index.test.ts for why leaving
				// 1M rows behind pollutes later tests' unfiltered deletes.
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
	},
);
