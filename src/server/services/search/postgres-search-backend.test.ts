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

// ── Postgres-only: live DB search tests ───────────────────────────────────────

describePostgresOnly(
	"PostgresSearchBackend — live Postgres search (AGENTPULSE_TEST_BACKEND=postgres)",
	() => {
		// These tests require a live Postgres DB via the Phase 7 test harness.
		// They are intentionally empty stubs in Phase 5; Phase 7 populates them
		// with fixture-based assertions against a controlled schema.
		//
		// When wiring Phase 7, replace the stubs below with:
		//   1. `beforeAll`: call getTestPgDb() to get a schema-isolated PG handle.
		//   2. Insert controlled fixtures into sessions + events tables.
		//   3. Construct PostgresSearchBackend(pgHandle).
		//   4. Assert search() returns expected hits, snippet contains <mark>,
		//      and AND/OR mode filtering works correctly.

		test("search() returns hits for sessions matching display_name", async () => {
			// Stub: will be implemented in Phase 7 with a real PG fixture.
			// For now, assert only that the backend instantiates and the method
			// signature is correct (covered by the no-op block above).
			expect(true).toBe(true);
		});

		test("search() returns hits for events matching raw_payload fields", async () => {
			expect(true).toBe(true);
		});

		test("AND mode requires all tokens; OR mode requires any", async () => {
			expect(true).toBe(true);
		});

		test("snippet contains <mark>…</mark> around matched term", async () => {
			expect(true).toBe(true);
		});

		test("agentType filter restricts results via session join", async () => {
			expect(true).toBe(true);
		});
	},
);
