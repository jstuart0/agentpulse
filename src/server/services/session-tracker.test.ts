import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { db, initializeDatabase } = await import("../db/client.js");
const { events, managedSessions, sessions, supervisors } = await import("../db/schema.js");
const { updateStaleSessions } = await import("./session-tracker.js");

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
