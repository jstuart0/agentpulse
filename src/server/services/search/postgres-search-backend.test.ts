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
	},
);
