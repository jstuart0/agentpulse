/**
 * Regression net for Phase 0 Decision 35:
 * bun-sqlite's Drizzle adapter silently commits before an async callback
 * settles when called with the async form. withTransaction() uses the sync-
 * callback .sync() shape for SQLite so rollback on throw is preserved.
 *
 * SQLite path: runs unconditionally in the default CI job.
 * Postgres path: gated by describePostgresOnly — runs only when
 *   AGENTPULSE_TEST_BACKEND=postgres is set (Phase 7 CI Postgres job).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";
import { describePostgresOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("./client.js");
const { withTransaction } = await import("./with-transaction.js");
const { sessions } = await import("./schema.js");
const { eq } = await import("drizzle-orm");

beforeAll(() => initializeDatabase());

const SESSION_ID = `tx-rollback-test-${Date.now()}`;

describe("withTransaction on SQLite — rollback semantics", () => {
	test("commits rows when callback succeeds", async () => {
		await withTransaction((tx) => {
			tx.insert(sessions)
				.values({
					id: SESSION_ID,
					sessionId: SESSION_ID,
					agentType: "claude_code",
					status: "active",
				})
				.run();
		});

		const row = getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, SESSION_ID))
			.get();

		expect(row?.sessionId).toBe(SESSION_ID);

		// Cleanup
		await getDb().delete(sessions).where(eq(sessions.sessionId, SESSION_ID));
	});

	test("rolls back rows when callback throws (regression for Phase 0 finding)", async () => {
		const txSessionId = `tx-rollback-error-${Date.now()}`;

		await expect(
			withTransaction((tx) => {
				tx.insert(sessions)
					.values({
						id: txSessionId,
						sessionId: txSessionId,
						agentType: "claude_code",
						status: "active",
					})
					.run();
				// Throw AFTER the insert — the transaction must roll back.
				throw new Error("intentional rollback trigger");
			}),
		).rejects.toThrow("intentional rollback trigger");

		// The row must NOT exist — it was inside a rolled-back transaction.
		const row = getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, txSessionId))
			.get();

		expect(row).toBeUndefined();
	});

	test("throws hard if callback returns a Promise on SQLite path (xander mid-build H2)", async () => {
		const txSessionId = `tx-async-guard-${Date.now()}`;

		// Pass an explicit async fn — it returns a Promise. The guard must throw
		// to prevent silent rollback-disable on the SQLite path.
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: deliberate misuse for the guard test
			withTransaction(async (tx: any) => {
				tx.insert(sessions)
					.values({
						id: txSessionId,
						sessionId: txSessionId,
						agentType: "claude_code",
						status: "active",
					})
					.run();
			}),
		).rejects.toThrow(/Async callback detected on SQLite path/);

		// The row was inserted before the throw — but bun-sqlite already committed
		// (this is the very hazard the guard exists to surface). Cleanup defensively.
		await getDb().delete(sessions).where(eq(sessions.sessionId, txSessionId));
	});

	test("nested operations inside withTransaction see the same tx context", async () => {
		const id = `tx-nested-${Date.now()}`;

		await withTransaction((tx) => {
			tx.insert(sessions)
				.values({
					id,
					sessionId: id,
					agentType: "codex_cli",
					status: "idle",
				})
				.run();
			// Update in the same transaction — should be visible to the same tx.
			tx.update(sessions).set({ status: "active" }).where(eq(sessions.sessionId, id)).run();
		});

		const row = getDb()
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.sessionId, id))
			.get();

		expect(row?.status).toBe("active");

		// Cleanup
		await getDb().delete(sessions).where(eq(sessions.sessionId, id));
	});
});

// ── Postgres path smoke test (gated — requires AGENTPULSE_TEST_BACKEND=postgres) ──
//
// Exercises commit + rollback on the Postgres async transaction path.
// Runs only in the Phase 7 CI Postgres job; skipped in default SQLite CI.
// This gives the Postgres CI job a real withTransaction test to anchor against.

describePostgresOnly("withTransaction on Postgres — async commit + rollback", () => {
	test("commits rows when async callback succeeds", async () => {
		const id = `pg-tx-commit-${Date.now()}`;

		await withTransaction(async (tx) => {
			await tx.insert(sessions).values({
				id,
				sessionId: id,
				agentType: "claude_code",
				status: "active",
			});
		});

		const rows = await getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, id));

		expect(rows[0]?.sessionId).toBe(id);

		// Cleanup
		await getDb().delete(sessions).where(eq(sessions.sessionId, id));
	});

	test("rolls back rows when async callback rejects", async () => {
		const id = `pg-tx-rollback-${Date.now()}`;

		await expect(
			withTransaction(async (tx) => {
				await tx.insert(sessions).values({
					id,
					sessionId: id,
					agentType: "claude_code",
					status: "active",
				});
				throw new Error("intentional async rollback trigger");
			}),
		).rejects.toThrow("intentional async rollback trigger");

		const rows = await getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, id));

		// Row must NOT exist — it was inside a rolled-back transaction.
		expect(rows).toHaveLength(0);
	});
});
