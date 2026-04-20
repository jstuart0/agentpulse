import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const {
	claimNextRun,
	dedupeKeyFor,
	enqueueRun,
	heartbeatRun,
	markFailed,
	markSucceeded,
	markRunning,
	reclaimExpiredLeases,
	queueSnapshot,
	listRecentRunsForSession,
} = await import("./watcher-runs-service.js");
const { aiWatcherRuns } = await import("../../db/schema.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiWatcherRuns).execute();
});

describe("watcher-runs-service", () => {
	test("enqueue then claim drives status transitions", async () => {
		const run = await enqueueRun({
			sessionId: "s1",
			triggerKind: "idle",
			triggerEventId: 42,
		});
		expect(run.status).toBe("queued");

		const claimed = await claimNextRun({
			leaseOwner: "owner-1",
			leaseDurationMs: 10_000,
		});
		expect(claimed?.id).toBe(run.id);
		expect(claimed?.status).toBe("claimed");
		expect(claimed?.leaseOwner).toBe("owner-1");
		expect(claimed?.attemptCount).toBe(1);
	});

	test("duplicate enqueue while one is open returns the existing run", async () => {
		const a = await enqueueRun({ sessionId: "s2", triggerKind: "idle" });
		const b = await enqueueRun({ sessionId: "s2", triggerKind: "idle" });
		expect(b.id).toBe(a.id);

		const snap = await queueSnapshot();
		expect(snap.queued).toBe(1);
	});

	test("dedupe key collapses same trigger within bucket", () => {
		const now = 1_700_000_000_000;
		const a = dedupeKeyFor({ sessionId: "s", triggerKind: "idle", now });
		const b = dedupeKeyFor({ sessionId: "s", triggerKind: "idle", now: now + 500 });
		const c = dedupeKeyFor({
			sessionId: "s",
			triggerKind: "idle",
			now: now + 60_000,
		});
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	test("mark succeeded clears lease and records proposal id", async () => {
		const run = await enqueueRun({ sessionId: "s3", triggerKind: "stop" });
		const claimed = await claimNextRun({
			leaseOwner: "owner-1",
			leaseDurationMs: 10_000,
		});
		expect(claimed).not.toBeNull();
		await markSucceeded({ id: run.id, proposalId: "prop-1" });

		const snap = await queueSnapshot();
		expect(snap.succeeded).toBe(1);
		const rows = await listRecentRunsForSession("s3");
		expect(rows[0].proposalId).toBe("prop-1");
		expect(rows[0].leaseOwner).toBeNull();
	});

	test("mark failed records error subtype", async () => {
		const run = await enqueueRun({ sessionId: "s4", triggerKind: "idle" });
		await claimNextRun({
			leaseOwner: "owner-1",
			leaseDurationMs: 10_000,
		});
		await markFailed({ id: run.id, errorSubType: "transient_rate_limit" });
		const snap = await queueSnapshot();
		expect(snap.failed).toBe(1);
		const rows = await listRecentRunsForSession("s4");
		expect(rows[0].lastErrorSubType).toBe("transient_rate_limit");
	});

	test("reclaim expired leases requeues runs below max attempts", async () => {
		const run = await enqueueRun({ sessionId: "s5", triggerKind: "idle" });
		await claimNextRun({
			leaseOwner: "owner-1",
			leaseDurationMs: 10_000,
		});
		await markRunning(run.id);

		// Force lease expiry.
		const past = new Date(Date.now() - 60_000).toISOString();
		await db.update(aiWatcherRuns).set({ leaseExpiresAt: past }).execute();

		const reclaimed = await reclaimExpiredLeases({ maxAttempts: 3 });
		expect(reclaimed).toBe(1);
		const snap = await queueSnapshot();
		expect(snap.queued).toBe(1);
		expect(snap.running).toBe(0);
	});

	test("reclaim expired leases expires runs past max attempts", async () => {
		const run = await enqueueRun({ sessionId: "s6", triggerKind: "idle" });
		await claimNextRun({ leaseOwner: "owner-1", leaseDurationMs: 10_000 });
		// Bump attempt count above ceiling.
		await db.update(aiWatcherRuns).set({ attemptCount: 3 }).execute();
		// Force lease expiry.
		const past = new Date(Date.now() - 60_000).toISOString();
		await db.update(aiWatcherRuns).set({ leaseExpiresAt: past }).execute();

		const reclaimed = await reclaimExpiredLeases({ maxAttempts: 3 });
		expect(reclaimed).toBe(1);
		const snap = await queueSnapshot();
		expect(snap.expired).toBe(1);
		expect(snap.queued).toBe(0);
	});

	test("heartbeat extends lease only for the owning leaser", async () => {
		const run = await enqueueRun({ sessionId: "s7", triggerKind: "idle" });
		await claimNextRun({ leaseOwner: "owner-1", leaseDurationMs: 10_000 });

		const ok = await heartbeatRun({
			id: run.id,
			leaseOwner: "owner-1",
			leaseDurationMs: 20_000,
		});
		expect(ok).toBe(true);

		const wrong = await heartbeatRun({
			id: run.id,
			leaseOwner: "other-owner",
			leaseDurationMs: 20_000,
		});
		expect(wrong).toBe(false);
	});

	test("only one run per session is open at a time (unique partial index)", async () => {
		await enqueueRun({ sessionId: "s8", triggerKind: "idle" });
		// Second enqueue should reuse the first; otherwise would violate index.
		const dup = await enqueueRun({ sessionId: "s8", triggerKind: "stop" });
		const runs = await listRecentRunsForSession("s8");
		expect(runs.length).toBe(1);
		expect(dup.triggerKind).toBe("idle");
	});
});
