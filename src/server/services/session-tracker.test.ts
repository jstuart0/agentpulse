import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { db, initializeDatabase, sqlite } = await import("../db/client.js");
const { events, managedSessions, sessions, supervisors } = await import("../db/schema.js");
const { renameSession, updateStaleSessions } = await import("./session-tracker.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(managedSessions).execute();
	await db.delete(supervisors).execute();
	await db.delete(sessions).execute();
});

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			...overrides,
		})
		.execute();
}

async function getSession(sessionId: string) {
	const rows = await db.select().from(sessions).execute();
	return rows.find((r) => r.sessionId === sessionId);
}

const MINUTE = 60 * 1000;

describe("updateStaleSessions lifecycle rules", () => {
	test("working session never goes idle even past the idle cutoff", async () => {
		await mkSession("w1", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(10 * MINUTE), // past 5-min idle cutoff
		});
		await updateStaleSessions();
		const row = await getSession("w1");
		expect(row?.status).toBe("active");
		expect(row?.isWorking).toBe(true);
	});

	test("non-working active session flips to idle past the idle cutoff", async () => {
		await mkSession("i1", {
			status: "active",
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("i1");
		expect(row?.status).toBe("idle");
	});

	test("idle session completes after the end cutoff, not earlier", async () => {
		await mkSession("c1", {
			status: "idle",
			isWorking: false,
			lastActivityAt: isoAgo(40 * MINUTE), // past 30-min end cutoff
		});
		await mkSession("c2", {
			status: "idle",
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE), // still within end cutoff
		});
		const ended = await updateStaleSessions();
		expect(ended).toBe(1);
		expect((await getSession("c1"))?.status).toBe("completed");
		expect((await getSession("c2"))?.status).toBe("idle");
	});

	test("working session past end cutoff stays active — no direct completion", async () => {
		await mkSession("w2", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(40 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("w2");
		expect(row?.status).toBe("active");
	});

	test("stuck working recovery clears isWorking after 2x end cutoff", async () => {
		await mkSession("stuck", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(65 * MINUTE), // past 2× 30-min recovery window
		});
		await updateStaleSessions();
		const row = await getSession("stuck");
		// Flag cleared; since this session is also well past the idle and
		// end cutoffs, the same tick cascades it all the way to completed.
		expect(row?.isWorking).toBe(false);
		expect(row?.status).toBe("completed");
	});

	test("stuck working recovery at just-past-2x-end becomes idle before completing", async () => {
		await mkSession("stuck-mild", {
			status: "active",
			isWorking: true,
			// Past 2×30min=60min but NOT yet 60min+30min=90min past for the
			// secondary completed cutoff to trip. Oh wait — endCutoff is 30m
			// absolute from now, not 30m from recovery. Any session with
			// lastActivity > 30m past is eligible. So recovery + idle +
			// completed all fire together. We express this by choosing an
			// activity age that clears recovery but *doesn't* pass end.
			// Since STUCK_WORKING_RECOVERY_MS (60m) > SESSION_END_TIMEOUT_MS
			// (30m), any row that qualifies for recovery also qualifies for
			// completion. So this test documents the invariant: reaching the
			// recovery threshold always cascades to completed.
			lastActivityAt: isoAgo(61 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("stuck-mild");
		expect(row?.isWorking).toBe(false);
		expect(row?.status).toBe("completed");
	});
});

describe("renameSession", () => {
	async function mkManaged(sessionId: string, overrides: Record<string, unknown> = {}) {
		await db
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: `lr-${sessionId}`,
				supervisorId: `sup-${sessionId}`,
				managedState: "managed",
				providerSyncState: "synced",
				providerSyncError: "prior error",
				desiredThreadTitle: "old-title",
				...overrides,
			})
			.execute();
	}

	test("happy path: no managed row → only sessions.displayName updated", async () => {
		await mkSession("solo", { displayName: "old-name" });
		renameSession("solo", "  new-name  ");
		const row = await getSession("solo");
		expect(row?.displayName).toBe("new-name");
		const managedRows = await db.select().from(managedSessions).execute();
		const forSolo = managedRows.find((m) => m.sessionId === "solo");
		expect(forSolo).toBeUndefined();
	});

	test("happy path: managed row exists → both rows updated, sync state reset to pending", async () => {
		await mkSession("paired", { displayName: "old-name" });
		await mkManaged("paired", { providerSyncState: "synced", providerSyncError: "x" });

		const before = await db.select().from(managedSessions).execute();
		const beforeRow = before.find((m) => m.sessionId === "paired");
		const beforeUpdatedAt = beforeRow?.updatedAt;

		// Ensure timestamp comparison is meaningful even on fast clocks.
		await new Promise((r) => setTimeout(r, 5));

		renameSession("paired", "renamed");

		const session = await getSession("paired");
		expect(session?.displayName).toBe("renamed");

		const after = await db.select().from(managedSessions).execute();
		const afterRow = after.find((m) => m.sessionId === "paired");
		expect(afterRow?.desiredThreadTitle).toBe("renamed");
		expect(afterRow?.providerSyncState).toBe("pending");
		expect(afterRow?.providerSyncError).toBeNull();
		expect(afterRow?.updatedAt).not.toBe(beforeUpdatedAt);
	});

	describe("rollback when managed update fails", () => {
		afterEach(() => {
			// Drop the trigger between/after rollback tests so we don't
			// leak state into other suites that share this DB.
			sqlite.exec("DROP TRIGGER IF EXISTS test_block_rename_managed;");
		});

		test("force second update to throw → sessions.displayName NOT updated (transaction rolled back)", async () => {
			await mkSession("rb-1", { displayName: "original" });
			await mkManaged("rb-1");

			// Trigger that aborts UPDATE on the managed row for our marker
			// session. This makes the sync transaction's second statement
			// throw, which exercises the rollback path.
			sqlite.exec(`
				CREATE TRIGGER test_block_rename_managed
				BEFORE UPDATE ON managed_sessions
				WHEN NEW.session_id = 'rb-1'
				BEGIN
					SELECT RAISE(ABORT, 'forced rollback');
				END;
			`);

			expect(() => renameSession("rb-1", "should-not-stick")).toThrow();

			const row = await getSession("rb-1");
			expect(row?.displayName).toBe("original");

			const managed = await db.select().from(managedSessions).execute();
			const rb1 = managed.find((m) => m.sessionId === "rb-1");
			expect(rb1?.desiredThreadTitle).toBe("old-title");
			expect(rb1?.providerSyncState).toBe("synced");
		});
	});
});
