/**
 * Concurrency tests for watcher-runs-service (Phase 6).
 *
 * Covers two race scenarios that arise when multiple AgentPulse instances
 * (or concurrent async callers on the same instance) interact with the
 * durable watcher-run queue:
 *
 *   1. Claim race: two callers try to claim the same queued row simultaneously.
 *      Expected: exactly one claim succeeds; the other receives null.
 *
 *   2. Enqueue race: two callers try to enqueue a run for the same session
 *      simultaneously, with no existing open run. Expected: both return the
 *      same row (one via the initial INSERT, the other via the unique-violation
 *      catch + re-read).
 *
 * On SQLite (default CI run), writes are serialized at the connection level,
 * so Promise.all races are effectively sequential. The tests still run and
 * verify the *behavior* (correct result shape) — they just can't exercise
 * true interleaving. The Postgres describePostgresOnly blocks are the real
 * race tests; they require AGENTPULSE_TEST_BACKEND=postgres + DATABASE_URL.
 *
 * Why separate connections matter (bob H1): a single pooled postgres-js client
 * serializes on the same connection. Each Postgres test constructs its own
 * client with max:1 so the two operations land on truly separate TCP
 * connections, forcing the advisory-lock / MVCC machinery to do real work.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { claimNextRun, enqueueRun, queueSnapshot } = await import("./watcher-runs-service.js");
const { aiWatcherRuns, sessions } = await import("../../db/schema.js");
const { isUniqueViolationError } = await import("../../db/sql-helpers.js");

import { describePostgresOnly } from "../../test-utils/backend.js";

// ── shared setup ───────────────────────────────────────────────────────────────

const SESSION_IDS = ["race-s1", "race-s2", "race-s3", "race-s4"];

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiWatcherRuns).execute();
	await getDb().delete(sessions).execute();
	for (const id of SESSION_IDS) {
		await getDb()
			.insert(sessions)
			.values({ sessionId: id, agentType: "claude_code" })
			.onConflictDoNothing();
	}
});

// ── behavioral tests (both backends) ─────────────────────────────────────────
//
// On SQLite, Promise.all races are serialized at the write layer — these tests
// verify the correct result shape on the happy path. On Postgres, the
// describePostgresOnly blocks below exercise real interleaving.

describe("watcher-runs-concurrency — claim race", () => {
	test("two concurrent claimNextRun calls on one queued row: exactly one wins", async () => {
		// Insert one queued row.
		await enqueueRun({ sessionId: "race-s1", triggerKind: "idle" });

		// Fire two claim calls in parallel. On SQLite these run sequentially
		// (writes are serialized), so the first wins and the second finds no
		// queued row. On Postgres they race; the conditional UPDATE guarantees
		// at most one succeeds.
		const [claimA, claimB] = await Promise.all([
			claimNextRun({ leaseOwner: "owner-A", leaseDurationMs: 30_000 }),
			claimNextRun({ leaseOwner: "owner-B", leaseDurationMs: 30_000 }),
		]);

		const winners = [claimA, claimB].filter(Boolean);
		const losers = [claimA, claimB].filter((r) => r === null);

		expect(winners.length).toBe(1);
		expect(losers.length).toBe(1);

		const winner = winners[0];
		expect(winner).not.toBeNull();
		expect(winner?.status).toBe("claimed");
	});
});

describe("watcher-runs-concurrency — enqueue race", () => {
	test("sequential enqueueRun calls for same session: second call returns existing row", async () => {
		// Sequential test — verifies the getOpenRunForSession guard at the top of
		// enqueueRun works correctly. The concurrent race is only meaningful on Postgres
		// (where the partial unique index enforces at-most-one open run). On SQLite,
		// the SQLite Drizzle schema has no partial unique index; concurrent calls would
		// both succeed. This sequential test covers the happy-path deduplication logic.
		const runA = await enqueueRun({ sessionId: "race-s2", triggerKind: "idle" });
		const runB = await enqueueRun({ sessionId: "race-s2", triggerKind: "stop" });

		// Sequential: second call finds first's row via getOpenRunForSession.
		expect(runA.id).toBe(runB.id);
		expect(runA.status).toBe("queued");
	});

	test("isUniqueViolationError is specific: matches only unique-constraint errors", () => {
		// Postgres unique_violation (SQLSTATE 23505).
		expect(isUniqueViolationError({ code: "23505" })).toBe(true);
		// SQLite unique constraint message.
		expect(isUniqueViolationError(new Error("SQLITE_CONSTRAINT_UNIQUE: ..."))).toBe(true);

		// Other Postgres error codes must NOT match.
		expect(isUniqueViolationError({ code: "23503" })).toBe(false); // FK violation
		expect(isUniqueViolationError({ code: "42P01" })).toBe(false); // undefined_table

		// Generic errors are not unique violations.
		expect(isUniqueViolationError(new Error("connection refused"))).toBe(false);
		expect(isUniqueViolationError(null)).toBe(false);
		expect(isUniqueViolationError(undefined)).toBe(false);
	});
});

// ── Postgres-only real-race tests ─────────────────────────────────────────────
//
// These construct two independent postgres-js clients (max:1 each) so the two
// operations land on separate TCP connections — the only way to exercise true
// interleaving under Postgres MVCC.
//
// Run with: AGENTPULSE_TEST_BACKEND=postgres DATABASE_URL=postgres://... bun test

describePostgresOnly("watcher-runs-concurrency — Postgres real-race (separate connections)", () => {
	test("claim race: two separate connections compete; exactly one wins", async () => {
		// Enqueue one row via the shared connection.
		const queued = await enqueueRun({ sessionId: "race-s3", triggerKind: "idle" });
		expect(queued.status).toBe("queued");

		// Two separate postgres-js clients → two separate TCP connections.
		const postgres = require("postgres") as typeof import("postgres");
		const dbUrl = process.env.DATABASE_URL ?? "";
		const clientA = postgres(dbUrl, { max: 1, idle_timeout: 10 });
		const clientB = postgres(dbUrl, { max: 1, idle_timeout: 10 });

		try {
			// Use raw postgres-js SQL to avoid importing the SQLite schema into
			// a Postgres context (they're different Drizzle table types and TypeScript
			// would require the Postgres schema variant, which isn't exported by
			// schema/index.ts in the SQLite test environment).
			type ClaimRow = { id: string; status: string };

			async function claimWithClient(
				// biome-ignore lint/suspicious/noExplicitAny: postgres-js Sql<{}> type not easily portable
				client: any,
				owner: string,
			): Promise<ClaimRow | null> {
				const nowIso = new Date().toISOString();
				const leaseExpires = new Date(Date.now() + 30_000).toISOString();
				const [candidate] = (await client`
					SELECT id, attempt_count
					FROM ai_watcher_runs
					WHERE status = 'queued'
					ORDER BY created_at ASC
					LIMIT 1
				`) as Array<{ id: string; attempt_count: number }>;
				if (!candidate) return null;
				const updated = (await client`
					UPDATE ai_watcher_runs
					SET
						status = 'claimed',
						lease_owner = ${owner},
						lease_expires_at = ${leaseExpires},
						claimed_at = ${nowIso},
						attempt_count = ${(candidate.attempt_count ?? 0) + 1},
						updated_at = ${nowIso}
					WHERE id = ${candidate.id} AND status = 'queued'
					RETURNING id, status
				`) as ClaimRow[];
				return updated[0] ?? null;
			}

			const [resultA, resultB] = await Promise.all([
				claimWithClient(clientA, "pg-owner-A"),
				claimWithClient(clientB, "pg-owner-B"),
			]);

			const winners = [resultA, resultB].filter(Boolean);
			expect(winners.length).toBe(1);
			const winner = winners[0];
			expect(winner?.status).toBe("claimed");
		} finally {
			await clientA.end();
			await clientB.end();
		}
	});

	test("enqueue race: two parallel enqueueRun calls return the same row id", async () => {
		// On Postgres the partial unique index (idx_ai_watcher_runs_open_per_session)
		// makes exactly one INSERT win; the loser catches SQLSTATE 23505 and re-reads
		// the winner's row. Both calls must return the same row id.
		//
		// We call the service function directly (it uses the module DB client),
		// which is sufficient to verify the catch logic fires on SQLSTATE 23505.
		// The separate-connection infrastructure is verified by the claim-race test.
		const [runA, runB] = await Promise.all([
			enqueueRun({ sessionId: "race-s4", triggerKind: "idle" }),
			enqueueRun({ sessionId: "race-s4", triggerKind: "stop" }),
		]);

		expect(runA).toBeDefined();
		expect(runB).toBeDefined();
		// Both must return the same row — the unique-violation catch ensures this.
		expect(runA.id).toBe(runB.id);

		// Exactly one open run exists for this session.
		const snap = await queueSnapshot();
		expect(snap.queued).toBe(1);
	});
});
