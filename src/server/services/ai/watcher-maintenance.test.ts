import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const schema = await import("../../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
	aiWatcherReports,
	aiWatcherRuns,
	controlActions,
	sessions,
	settings,
	watcherConfigs,
	watcherProposals,
} = schema;
const {
	WATCHER_CLEANUP_MARKER_KEY,
	abandonOrphanedPendingProposals,
	runWatcherMaintenanceOnce,
	sweepWatcherOnStart,
} = await import("./watcher-maintenance.js");

const HOUR_MS = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	const db = getDb();
	await db.delete(settings).where(eq(settings.key, WATCHER_CLEANUP_MARKER_KEY));
	await db.delete(aiWatcherRuns);
	await db.delete(watcherProposals);
	await db.delete(watcherConfigs);
	await db.delete(aiHitlRequests);
	await db.delete(aiWatcherReports);
	await db.delete(sessions);
});

async function seedSession(sessionId: string): Promise<void> {
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" });
}

let runSeq = 0;
async function seedRun(
	sessionId: string,
	fields: Partial<typeof aiWatcherRuns.$inferInsert> = {},
): Promise<string> {
	runSeq += 1;
	const id = `run-${String(runSeq).padStart(5, "0")}-${crypto.randomUUID().slice(0, 8)}`;
	await getDb()
		.insert(aiWatcherRuns)
		.values({
			id,
			sessionId,
			triggerKind: "manual",
			status: "succeeded",
			dedupeKey: `${sessionId}:${id}`,
			claimedAt: iso(-10 * HOUR_MS),
			completedAt: iso(-10 * HOUR_MS + 1_000),
			...fields,
		});
	return id;
}

async function runIds(): Promise<Set<string>> {
	const rows = await getDb().select({ id: aiWatcherRuns.id }).from(aiWatcherRuns);
	return new Set(rows.map((r) => r.id));
}

describe("runWatcherMaintenanceOnce", () => {
	async function seedEverything() {
		const plain: string[] = [];
		const withProposalId: string[] = [];
		const failed: string[] = [];
		const eventTriggered: string[] = [];
		await seedSession("plain");
		for (let i = 0; i < 5; i += 1) {
			plain.push(await seedRun("plain"));
			withProposalId.push(await seedRun("plain", { proposalId: `prop-${i}` }));
			failed.push(await seedRun("plain", { status: "failed" }));
			eventTriggered.push(await seedRun("plain", { triggerKind: "stop", triggerEventId: 100 + i }));
		}

		// A run that made a proposal inside its own window but never recorded it.
		await seedSession("windowed");
		const claimed = Date.now() - 5 * HOUR_MS;
		const windowRun = await seedRun("windowed", {
			claimedAt: new Date(claimed).toISOString(),
			completedAt: new Date(claimed + 60_000).toISOString(),
		});
		await getDb()
			.insert(watcherProposals)
			.values({
				id: "window-proposal",
				sessionId: "windowed",
				providerId: "p",
				state: "complete",
				createdAt: new Date(claimed + 30_000).toISOString(),
			});

		// Pending proposals: one stale and orphaned, one fresh.
		await seedSession("old-pending");
		await getDb()
			.insert(watcherProposals)
			.values({
				id: "old-pending",
				sessionId: "old-pending",
				providerId: "p",
				state: "pending",
				createdAt: iso(-2 * HOUR_MS),
			});
		await seedSession("new-pending");
		await getDb()
			.insert(watcherProposals)
			.values({
				id: "new-pending",
				sessionId: "new-pending",
				providerId: "p",
				state: "pending",
				createdAt: iso(-5 * 60_000),
			});

		// Configs.
		for (const [sessionId, policy] of [
			["auto-1", "auto"],
			["auto-2", "auto"],
			["ask-1", "ask_always"],
		] as const) {
			await seedSession(sessionId);
			await getDb().insert(watcherConfigs).values({
				sessionId,
				providerId: "p",
				enabled: true,
				policy,
				autoConfirmedAt: "2026-01-01T00:00:00.000Z",
				autoConfirmedBy: "someone",
			});
		}

		// HITLs: two open (different sessions), one applied.
		for (const [id, sessionId, status] of [
			["hitl-open-1", "auto-1", "awaiting_reply"],
			["hitl-open-2", "auto-2", "awaiting_reply"],
			["hitl-applied", "ask-1", "applied"],
		] as const) {
			await getDb()
				.insert(aiHitlRequests)
				.values({ id, proposalId: `${id}-p`, sessionId, status });
		}
		return { plain, withProposalId, failed, eventTriggered, windowRun };
	}

	test("deletes exactly the trigger-less no-op runs and converts auto, supersedes open HITLs", async () => {
		const seeded = await seedEverything();
		const before = await runIds();
		expect(before.size).toBe(21);

		const result = await runWatcherMaintenanceOnce();
		expect(result).not.toBeNull();
		expect(result?.deletedRuns).toBe(5);
		expect(result?.keptByProposalWindow).toBe(1);
		expect(result?.abandonedProposals).toBe(1);
		expect(result?.autoConverted).toBe(2);
		expect(result?.hitlsSuperseded).toBe(2);

		const after = await runIds();
		const expectedKept = new Set(before);
		for (const id of seeded.plain) expectedKept.delete(id);
		expect(after).toEqual(expectedKept);
		// Named member: the run that made a proposal inside its window stays.
		expect(after.has(seeded.windowRun)).toBe(true);
		for (const id of [...seeded.withProposalId, ...seeded.failed, ...seeded.eventTriggered]) {
			expect(after.has(id), id).toBe(true);
		}

		const proposals = await getDb().select().from(watcherProposals);
		const byId = new Map(proposals.map((p) => [p.id, p]));
		expect(byId.get("old-pending")?.state).toBe("cancelled");
		expect(byId.get("old-pending")?.errorSubType).toBe("abandoned");
		expect(byId.get("new-pending")?.state).toBe("pending");
		expect(byId.get("window-proposal")?.state).toBe("complete");

		const configs = await getDb().select().from(watcherConfigs);
		const policies = new Map(configs.map((c) => [c.sessionId, c]));
		for (const id of ["auto-1", "auto-2"]) {
			expect(policies.get(id)?.policy).toBe("ask_on_risk");
			expect(policies.get(id)?.autoConfirmedAt).toBeNull();
			expect(policies.get(id)?.autoConfirmedBy).toBeNull();
		}
		expect(policies.get("ask-1")?.policy).toBe("ask_always");
		expect(policies.get("ask-1")?.autoConfirmedBy).toBe("someone");

		const hitls = await getDb().select().from(aiHitlRequests);
		const status = new Map(hitls.map((h) => [h.id, h.status]));
		expect(status.get("hitl-open-1")).toBe("superseded");
		expect(status.get("hitl-open-2")).toBe("superseded");
		expect(status.get("hitl-applied")).toBe("applied");

		const [marker] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, WATCHER_CLEANUP_MARKER_KEY));
		expect(marker?.value).toMatchObject({ deletedRuns: 5, autoConverted: 2, hitlsSuperseded: 2 });
	});

	test("a second call is a no-op", async () => {
		const seeded = await seedEverything();
		await runWatcherMaintenanceOnce();
		const afterFirst = await runIds();
		// Reintroduce a candidate: the marker must stop it being deleted.
		const late = await seedRun("plain");
		expect(await runWatcherMaintenanceOnce()).toBeNull();
		const afterSecond = await runIds();
		expect(afterSecond.has(late)).toBe(true);
		expect(afterSecond.size).toBe(afterFirst.size + 1);
		expect(afterSecond.has(seeded.windowRun)).toBe(true);
	});

	test("keeps a run whose window can't be read, and batches over 1,000 rows", async () => {
		await seedSession("big");
		const unreadable = await seedRun("big", { claimedAt: null });
		const ids: string[] = [];
		const values = Array.from({ length: 1_100 }, (_, i) => {
			const id = `bulk-${String(i).padStart(5, "0")}`;
			ids.push(id);
			return {
				id,
				sessionId: "big",
				triggerKind: "manual",
				status: "succeeded",
				dedupeKey: `big:${id}`,
				claimedAt: iso(-3 * HOUR_MS),
				completedAt: iso(-3 * HOUR_MS + 1_000),
			};
		});
		for (let i = 0; i < values.length; i += 300) {
			await getDb()
				.insert(aiWatcherRuns)
				.values(values.slice(i, i + 300));
		}
		const result = await runWatcherMaintenanceOnce();
		expect(result?.deletedRuns).toBe(1_100);
		expect(result?.keptByProposalWindow).toBe(1);
		const left = await runIds();
		expect(left).toEqual(new Set([unreadable]));
	});
});

describe("abandonOrphanedPendingProposals", () => {
	test("leaves a stale pending proposal alone while its session has an open run", async () => {
		await seedSession("busy");
		await getDb()
			.insert(watcherProposals)
			.values({
				id: "busy-pending",
				sessionId: "busy",
				providerId: "p",
				state: "pending",
				createdAt: iso(-3 * HOUR_MS),
			});
		await seedRun("busy", { status: "running" });
		expect(await abandonOrphanedPendingProposals(HOUR_MS)).toBe(0);
		const [row] = await getDb()
			.select()
			.from(watcherProposals)
			.where(eq(watcherProposals.id, "busy-pending"));
		expect(row?.state).toBe("pending");
	});
});

describe("sweepWatcherOnStart", () => {
	test("fails every claimed report whatever its age, times out overdue HITLs, reconciles old pending audit rows", async () => {
		await seedSession("sweep");
		await getDb()
			.insert(aiWatcherReports)
			.values([
				{
					id: "claimed-fresh",
					sessionId: "sweep",
					turnKey: "p:1",
					status: "claimed",
					createdAt: iso(-5_000),
				},
				{
					id: "claimed-old",
					sessionId: "sweep",
					turnKey: "p:2",
					status: "claimed",
					createdAt: iso(-3 * HOUR_MS),
				},
				{ id: "delivered", sessionId: "sweep", turnKey: "p:3", status: "delivered" },
			]);

		await getDb()
			.insert(aiHitlRequests)
			.values({
				id: "overdue",
				proposalId: "p",
				sessionId: "sweep",
				status: "awaiting_reply",
				expiresAt: iso(-60_000),
			});

		const tag = crypto.randomUUID().slice(0, 8);
		const sentActionId = `ca-sent-${tag}`;
		await getDb()
			.insert(controlActions)
			.values({ id: sentActionId, sessionId: "sweep", actionType: "prompt", requestedBy: "ai" });
		const audit = (id: string, createdAt: string, controlActionId: string) => ({
			id,
			createdAt,
			sessionId: "sweep",
			actorKind: "auto" as const,
			controlActionId,
		});
		const auditIds = {
			withAction: `audit-with-${tag}`,
			withoutAction: `audit-without-${tag}`,
			recent: `audit-recent-${tag}`,
		};
		await getDb()
			.insert(aiDispatchAudit)
			.values([
				audit(auditIds.withAction, iso(-10 * 60_000), sentActionId),
				audit(auditIds.withoutAction, iso(-10 * 60_000), `ca-missing-${tag}`),
				audit(auditIds.recent, iso(-60_000), `ca-recent-${tag}`),
			]);

		const result = await sweepWatcherOnStart();
		expect(result.abandonedReports).toBe(2);
		expect(result.timedOutHitl).toBe(1);
		expect(result.reconciledAudit).toBeGreaterThanOrEqual(2);

		const reports = await getDb().select().from(aiWatcherReports);
		const byId = new Map(reports.map((r) => [r.id, r]));
		for (const id of ["claimed-fresh", "claimed-old"]) {
			expect(byId.get(id)?.status, id).toBe("failed");
			expect(byId.get(id)?.failureCode, id).toBe("abandoned");
		}
		expect(byId.get("delivered")?.status).toBe("delivered");

		const [hitl] = await getDb()
			.select()
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.id, "overdue"));
		expect(hitl?.status).toBe("timed_out");

		const rows = await getDb()
			.select()
			.from(aiDispatchAudit)
			.where(inArray(aiDispatchAudit.id, Object.values(auditIds)));
		const outcome = new Map(rows.map((r) => [r.id, r]));
		expect(outcome.get(auditIds.withAction)?.outcome).toBe("sent");
		expect(outcome.get(auditIds.withoutAction)?.outcome).toBe("failed");
		expect(outcome.get(auditIds.withoutAction)?.refusalCode).toBe("abandoned");
		// Positive control for the age rule: a one-minute-old pending row is left alone.
		expect(outcome.get(auditIds.recent)?.outcome).toBe("pending");
	});
});
