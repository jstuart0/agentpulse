/**
 * Regression net for Phase 0 Decision 35 (revised Phase 8):
 * withTransaction() now uses manual BEGIN/COMMIT/ROLLBACK on the SQLite path
 * so async callbacks are safe — COMMIT fires only after the Promise resolves.
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
const { sessions } = await import("./schema/index.js");
const { eq } = await import("drizzle-orm");

beforeAll(() => initializeDatabase());

const SESSION_ID = `tx-rollback-test-${Date.now()}`;

describe("withTransaction on SQLite — rollback semantics", () => {
	test("commits rows when async callback succeeds", async () => {
		await withTransaction(async (tx) => {
			await tx.insert(sessions).values({
				id: SESSION_ID,
				sessionId: SESSION_ID,
				agentType: "claude_code",
				status: "active",
			});
		});

		const [row] = await getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, SESSION_ID));

		expect(row?.sessionId).toBe(SESSION_ID);

		// Cleanup
		await getDb().delete(sessions).where(eq(sessions.sessionId, SESSION_ID));
	});

	test("rolls back rows when async callback throws (regression for Phase 0 finding)", async () => {
		const txSessionId = `tx-rollback-error-${Date.now()}`;

		await expect(
			withTransaction(async (tx) => {
				await tx.insert(sessions).values({
					id: txSessionId,
					sessionId: txSessionId,
					agentType: "claude_code",
					status: "active",
				});
				// Throw AFTER the insert — the transaction must roll back.
				throw new Error("intentional rollback trigger");
			}),
		).rejects.toThrow("intentional rollback trigger");

		// The row must NOT exist — it was inside a rolled-back transaction.
		const [row] = await getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.sessionId, txSessionId));

		expect(row).toBeUndefined();
	});

	test("nested operations inside withTransaction see the same tx context", async () => {
		const id = `tx-nested-${Date.now()}`;

		await withTransaction(async (tx) => {
			await tx.insert(sessions).values({
				id,
				sessionId: id,
				agentType: "codex_cli",
				status: "idle",
			});
			// Update in the same transaction — should be visible to the same tx.
			await tx.update(sessions).set({ status: "active" }).where(eq(sessions.sessionId, id));
		});

		const [row] = await getDb()
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.sessionId, id));

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
