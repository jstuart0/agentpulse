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
	test("searchSessions calls executeRows with a Drizzle SQL template, not { sql, params }", async () => {
		let capturedQuery: unknown = undefined;

		// Capture from whichever path executeRows() takes on this dialect.
		// executeRows branches on config.dialect: Postgres → db.execute(q), SQLite → db.all(q).
		// Both paths receive the same Drizzle SQL template object.
		const mockDb = {
			execute: (q: unknown) => {
				capturedQuery = q;
				return Promise.resolve([] as unknown[]);
			},
			all: (q: unknown) => {
				capturedQuery = q;
				return [] as unknown[];
			},
		};

		const backend = new PostgresSearchBackend(
			mockDb as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				typeof import("../../db/schema/index.js")
			>,
		);

		// Call search() so searchSessions() is invoked.
		await backend.search({ q: "hello", kinds: ["session"] });

		// capturedQuery must be a Drizzle SQL template object, not a plain object
		// with a `sql` string and a `params` array (the broken shape that would
		// throw `TypeError: query.getSQL is not a function` on the real adapter).
		expect(capturedQuery).toBeDefined();
		expect(typeof capturedQuery).toBe("object");
		// Drizzle SQL templates have a `getSQL()` method; plain `{ sql, params }` objects do not.
		// biome-ignore lint/suspicious/noExplicitAny: testing internal drizzle shape
		expect(typeof (capturedQuery as any).getSQL).toBe("function");
		// Must NOT be a plain { sql: string, params: [] } object.
		expect(typeof (capturedQuery as Record<string, unknown>)?.sql).not.toBe("string");
	});

	test("searchEvents calls executeRows with a Drizzle SQL template, not { sql, params }", async () => {
		let capturedQuery: unknown = undefined;

		const mockDb = {
			execute: (q: unknown) => {
				capturedQuery = q;
				return Promise.resolve([] as unknown[]);
			},
			all: (q: unknown) => {
				capturedQuery = q;
				return [] as unknown[];
			},
		};

		const backend = new PostgresSearchBackend(
			mockDb as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase<
				typeof import("../../db/schema/index.js")
			>,
		);

		await backend.search({ q: "world", kinds: ["event"] });

		expect(capturedQuery).toBeDefined();
		expect(typeof capturedQuery).toBe("object");
		// biome-ignore lint/suspicious/noExplicitAny: testing internal drizzle shape
		expect(typeof (capturedQuery as any).getSQL).toBe("function");
		expect(typeof (capturedQuery as Record<string, unknown>)?.sql).not.toBe("string");
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

		// ── percy AGEN-27 review, Critical 1: event indexes survive plan-cache warm-up ──
		//
		// postgres-js prepares statements by default. Postgres's own planner
		// switches a repeatedly-executed prepared statement from a per-call
		// "custom" plan (which sees the actual bound values) to a cached
		// "generic" plan (built once, ignorant of values) once it estimates
		// the generic plan is cheap enough — typically within the first
		// ~5-10 executions, though the exact trigger is cost-heuristic and
		// data-dependent, not a fixed call count. A *bound-parameter*
		// `event_type IN (...)` list is opaque at generic-plan-build time, so
		// the planner can't prove the six events trigram indexes' partial
		// `WHERE event_type IN (...)` predicate is satisfied — all six get
		// silently dropped in favor of a sequential scan.
		//
		// This test drives the real production path (PostgresSearchBackend.
		// search()) on one dedicated connection, warms it 8+ times (per the
		// review), then forces `plan_cache_mode = force_generic_plan` on
		// that same connection — deterministically reproducing the
		// worst-case post-warm-up state the natural heuristic reaches only
		// eventually and data-dependently — and asserts the next call stays
		// index-fast, not seq-scan-slow.
		test("stays index-backed after prepared-statement warm-up (not a bound event_type IN list)", async () => {
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

			// One dedicated connection so postgres-js's own prepared-statement
			// cache and Postgres's plan-cache state both persist across every
			// call below — a pooled connection could silently route calls to
			// different physical backends, each with its own plan cache.
			const pgClient = postgres(config.databaseUrl, { max: 1 });
			const dedicatedDb: PgDb = drizzle(pgClient, { schema });
			const sid = uid("pgsearch-warmup");

			try {
				const backend = new PostgresSearchBackend(dedicatedDb);

				const marker = uid("tok").replace(/-/g, "");
				const ROW_COUNT = 300_000;

				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`INSERT INTO sessions (id, session_id, agent_type, status) VALUES (gen_random_uuid()::text, ${sid}, 'claude_code', 'active')`,
				);

				// Rare marker (1 in 5000), realistic selectivity — a naive
				// "every 5th row" fixture is unrealistically easy for a seq
				// scan and would hide the index's actual advantage.
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
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
				await executeRows(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`ANALYZE events`,
				);

				// Warm up ≥8 executions through the real production call path.
				for (let i = 0; i < 8; i++) {
					await backend.search({ q: marker, kinds: ["event"], sessionId: sid });
				}

				// Corroborating evidence: this connection really did go through
				// postgres-js's own server-side prepared-statement machinery
				// (prepare: true, the default) — not some test-only shortcut.
				const prepared = await executeRows<{ count: string }>(
					dedicatedDb as unknown as import("../../db/client.js").Db,
					sql`SELECT count(*)::text AS count FROM pg_prepared_statements`,
				);
				expect(Number(prepared[0]?.count ?? 0)).toBeGreaterThan(0);

				// Deterministically reproduce the worst case the natural
				// custom-vs-generic heuristic reaches only eventually and
				// data-dependently: force every subsequent execution on this
				// connection to use a generic plan.
				await pgClient.unsafe("SET plan_cache_mode = force_generic_plan");

				const start = performance.now();
				const result = await backend.search({ q: marker, kinds: ["event"], sessionId: sid });
				const elapsedMs = performance.now() - start;

				// Correctness: the search must still find the seeded hit.
				expect(result.hits.length).toBeGreaterThan(0);

				// The whole point: index-backed stays fast even under a forced
				// generic plan. Broken (bound event_type IN list, or an
				// unfenced ORDER BY/LIMIT that lets the planner walk
				// idx_events_created_at_id instead): 160-185ms measured at
				// this row count. Fixed (literal IN list + MATERIALIZED CTE
				// fence): a few ms of raw query time, tens of ms including
				// JS-side row mapping and connection round-trip. 80ms leaves
				// a wide margin below the broken numbers and above observed
				// fixed-path noise.
				expect(elapsedMs).toBeLessThan(80);
			} finally {
				// Cleanup — see pg-trgm-search-index.test.ts for why leaving
				// 300k rows behind pollutes later tests' unfiltered deletes.
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
		}, 60_000);
	},
);
