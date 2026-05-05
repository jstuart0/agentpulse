/**
 * Regression net for Phase 0 Decision 35:
 * bun-sqlite's Drizzle adapter silently commits before an async callback
 * settles when called with the async form. withTransaction() uses the sync-
 * callback .sync() shape for SQLite so rollback on throw is preserved.
 *
 * These tests run only on the SQLite path (the Postgres path is not available
 * in CI without a running Postgres instance — that axis is covered in Phase 7).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

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
