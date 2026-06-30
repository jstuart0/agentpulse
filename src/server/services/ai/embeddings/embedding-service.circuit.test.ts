/**
 * Circuit-breaker tests for the embedding-service backfill loop (AGEN-7).
 *
 * Injects a failing adapter and verifies:
 *   1. The loop makes a bounded number of attempts (≤ MAX_CONSECUTIVE_FAILURES).
 *   2. The circuit opens and the loop exits cleanly rather than spinning forever.
 *   3. A succeeding adapter completes normally and does not set circuitOpen.
 *
 * Uses the real in-memory SQLite DB so the batch query path is exercised end-to-end.
 * Backoff delay is overridden to 0 ms for instant test cycles.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { initializeDatabase, getDb, getSqlite } = await import("../../../db/client.js");
const { sessions, events } = await import("../../../db/schema/index.js");
const {
	runBackfill,
	__resetEmbeddingAdapterForTests,
	__setEmbeddingAdapterForTests,
	__setBackfillBackoffForTests,
} = await import("./embedding-service.js");

const originalVectorSearch = config.vectorSearchEnabled;

// Use a non-existent session id unique to this test file to avoid FK collisions with
// other test suites that may run concurrently in the same temp DB.
const SESSION_ID = "circuit-test-session-embed";

beforeAll(async () => {
	await initializeDatabase();
	// Enable vector search for the duration of this suite.
	// dialect resolves naturally to "sqlite" since DATABASE_URL is unset in tests.
	(config as Record<string, unknown>).vectorSearchEnabled = true;
	// Seed parent session once — events FK requires it.
	await getDb()
		.insert(sessions)
		.values({ sessionId: SESSION_ID, agentType: "claude_code" })
		.onConflictDoNothing();
	// Use zero-delay backoff for all tests in this file.
	__setBackfillBackoffForTests(() => 0);
});

afterAll(() => {
	// Restore original config value so other test suites are unaffected.
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	// Restore default backoff so other test suites are unaffected.
	__setBackfillBackoffForTests((attempt) => Math.min(1_000 * 2 ** (attempt - 1), 30_000));
	__resetEmbeddingAdapterForTests();
});

beforeEach(async () => {
	// Clear state between tests.
	__resetEmbeddingAdapterForTests();
	getSqlite().exec("DELETE FROM event_embeddings");
	await getDb().delete(events).execute();
	// Insert one event so the batch query returns rows and we reach the embed call.
	await getDb()
		.insert(events)
		.values({
			sessionId: SESSION_ID,
			eventType: "UserPromptSubmit",
			rawPayload: { prompt: "hello circuit breaker" },
		});
});

describe("embedding-service circuit breaker (AGEN-7)", () => {
	test("adapter that always throws opens circuit after MAX_CONSECUTIVE_FAILURES attempts", async () => {
		let callCount = 0;
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: "circuit-test-model",
			dim: 4,
			embed: async (_input: string): Promise<Float32Array> => {
				callCount++;
				throw new Error("connection refused");
			},
		});

		const result = await runBackfill();

		// Loop must exit cleanly — not still running.
		expect(result.running).toBe(false);
		// Error state must indicate circuit open.
		expect(result.error).toMatch(/circuit open/);
		// Exactly MAX_CONSECUTIVE_FAILURES (5) attempts before breaking.
		expect(callCount).toBeGreaterThan(0);
		expect(callCount).toBeLessThanOrEqual(5);
	});

	test("does NOT spin forever on persistent failure (batch attempt count is bounded)", async () => {
		// Track batch-level attempts (one call to embedBatch per loop iteration).
		// With N texts in a batch, using embed() would multiply the call count by N,
		// obscuring the "bounded number of LOOP ITERATIONS" invariant we care about.
		let batchAttempts = 0;
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: "circuit-test-model",
			dim: 4,
			embed: async (_input: string): Promise<Float32Array> => {
				throw new Error("endpoint permanently down");
			},
			// embedBatch is called once per loop iteration, making the counter directly
			// correspond to consecutive-failure count (≤ MAX_CONSECUTIVE_FAILURES = 5).
			embedBatch: async (_inputs: string[]): Promise<Float32Array[]> => {
				batchAttempts++;
				throw new Error("endpoint permanently down");
			},
		});

		// Insert extra events to ensure multiple-batch territory, confirming the
		// circuit opens after the failure limit, not after a single event processes.
		for (let i = 0; i < 40; i++) {
			await getDb()
				.insert(events)
				.values({
					sessionId: SESSION_ID,
					eventType: "AssistantMessage",
					rawPayload: { message: `msg ${i}` },
				});
		}

		const result = await runBackfill();

		// The circuit must open after exactly MAX_CONSECUTIVE_FAILURES batch attempts.
		// This is the definitive "does NOT loop forever" assertion.
		expect(batchAttempts).toBeGreaterThan(0);
		expect(batchAttempts).toBeLessThanOrEqual(5);
		expect(result.running).toBe(false);
		expect(result.error).toMatch(/circuit open/);
	});

	test("succeeding adapter completes normally without circuit-open error", async () => {
		const fakeVector = new Float32Array(4).fill(0.25);
		let callCount = 0;
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: "circuit-test-model",
			dim: 4,
			embed: async (_input: string): Promise<Float32Array> => {
				callCount++;
				return fakeVector;
			},
		});

		const result = await runBackfill();

		expect(result.running).toBe(false);
		expect(result.error).toBeNull();
		// At least one embed call for our inserted event.
		expect(callCount).toBeGreaterThan(0);
	});

	test("circuit resets per runBackfill invocation — a fresh call after circuit-open starts with zero failures", async () => {
		let failingCalls = 0;
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: "circuit-test-model",
			dim: 4,
			embed: async (_input: string): Promise<Float32Array> => {
				failingCalls++;
				throw new Error("down");
			},
		});

		const first = await runBackfill();
		expect(first.error).toMatch(/circuit open/);

		// Second invocation: adapter still failing but circuit counter resets.
		const callsBefore = failingCalls;
		const second = await runBackfill();
		expect(second.error).toMatch(/circuit open/);
		// Second run also made up to 5 new attempts (not 0 because counter was reset).
		expect(failingCalls - callsBefore).toBeGreaterThan(0);
		expect(failingCalls - callsBefore).toBeLessThanOrEqual(5);
	});
});
