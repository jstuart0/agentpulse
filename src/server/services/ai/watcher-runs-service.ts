import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiWatcherRuns } from "../../db/schema.js";

export type WatcherRunStatus =
	| "queued"
	| "claimed"
	| "running"
	| "succeeded"
	| "failed"
	| "expired"
	| "cancelled";

export type WatcherRunTriggerKind = "idle" | "stop" | "error" | "plan_completed" | "manual";

export interface WatcherRunRecord {
	id: string;
	sessionId: string;
	triggerEventId: number | null;
	triggerKind: WatcherRunTriggerKind;
	status: WatcherRunStatus;
	dedupeKey: string;
	leaseOwner: string | null;
	leaseExpiresAt: string | null;
	attemptCount: number;
	lastErrorSubType: string | null;
	claimedAt: string | null;
	completedAt: string | null;
	proposalId: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof aiWatcherRuns.$inferSelect): WatcherRunRecord {
	return {
		id: row.id,
		sessionId: row.sessionId,
		triggerEventId: row.triggerEventId,
		triggerKind: row.triggerKind as WatcherRunTriggerKind,
		status: row.status as WatcherRunStatus,
		dedupeKey: row.dedupeKey,
		leaseOwner: row.leaseOwner,
		leaseExpiresAt: row.leaseExpiresAt,
		attemptCount: row.attemptCount,
		lastErrorSubType: row.lastErrorSubType,
		claimedAt: row.claimedAt,
		completedAt: row.completedAt,
		proposalId: row.proposalId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Compute a dedupe key from the session id and a coarse trigger bucket.
 * Two wakes that hash to the same key within the debounce window collapse
 * into one queued run.
 */
export function dedupeKeyFor(input: {
	sessionId: string;
	triggerKind: WatcherRunTriggerKind;
	bucketMs?: number;
	now?: number;
}): string {
	const bucket = input.bucketMs ?? 10_000;
	const ts = input.now ?? Date.now();
	const bucketStart = Math.floor(ts / bucket) * bucket;
	return createHash("sha1")
		.update(`${input.sessionId}|${input.triggerKind}|${bucketStart}`)
		.digest("hex");
}

/**
 * Enqueue a durable wake for a session. If an open run (queued | claimed |
 * running) already exists for the session, this is a no-op and returns the
 * existing row — the unique partial index enforces "one open run per
 * session" as an invariant, so we don't need to coordinate across callers.
 */
export async function enqueueRun(input: {
	sessionId: string;
	triggerEventId?: number | null;
	triggerKind: WatcherRunTriggerKind;
}): Promise<WatcherRunRecord> {
	const existing = await getOpenRunForSession(input.sessionId);
	if (existing) return existing;
	const now = new Date().toISOString();
	const [row] = await db
		.insert(aiWatcherRuns)
		.values({
			sessionId: input.sessionId,
			triggerEventId: input.triggerEventId ?? null,
			triggerKind: input.triggerKind,
			status: "queued",
			dedupeKey: dedupeKeyFor({
				sessionId: input.sessionId,
				triggerKind: input.triggerKind,
			}),
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

/** Find the single open (non-terminal) run for a session, if any. */
export async function getOpenRunForSession(sessionId: string): Promise<WatcherRunRecord | null> {
	const [row] = await db
		.select()
		.from(aiWatcherRuns)
		.where(
			and(
				eq(aiWatcherRuns.sessionId, sessionId),
				inArray(aiWatcherRuns.status, ["queued", "claimed", "running"]),
			),
		)
		.orderBy(desc(aiWatcherRuns.createdAt))
		.limit(1);
	return row ? toRecord(row) : null;
}

/**
 * Attempt to claim the next queued run for processing. Uses a conditional
 * UPDATE so that in a multi-instance world only one lease holder wins even
 * if two leasers race. Returns the claimed row or null if the queue is
 * empty.
 */
export async function claimNextRun(input: {
	leaseOwner: string;
	leaseDurationMs: number;
	now?: Date;
}): Promise<WatcherRunRecord | null> {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const leaseExpires = new Date(now.getTime() + input.leaseDurationMs).toISOString();

	const [candidate] = await db
		.select()
		.from(aiWatcherRuns)
		.where(eq(aiWatcherRuns.status, "queued"))
		.orderBy(asc(aiWatcherRuns.createdAt))
		.limit(1);
	if (!candidate) return null;

	const updated = await db
		.update(aiWatcherRuns)
		.set({
			status: "claimed",
			leaseOwner: input.leaseOwner,
			leaseExpiresAt: leaseExpires,
			claimedAt: nowIso,
			attemptCount: (candidate.attemptCount ?? 0) + 1,
			updatedAt: nowIso,
		})
		.where(and(eq(aiWatcherRuns.id, candidate.id), eq(aiWatcherRuns.status, "queued")))
		.returning();
	return updated[0] ? toRecord(updated[0]) : null;
}

export async function markRunning(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(aiWatcherRuns)
		.set({ status: "running", updatedAt: now })
		.where(eq(aiWatcherRuns.id, id));
}

export async function markSucceeded(input: {
	id: string;
	proposalId?: string | null;
}): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(aiWatcherRuns)
		.set({
			status: "succeeded",
			proposalId: input.proposalId ?? null,
			completedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(eq(aiWatcherRuns.id, input.id));
}

export async function markFailed(input: {
	id: string;
	errorSubType: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(aiWatcherRuns)
		.set({
			status: "failed",
			lastErrorSubType: input.errorSubType,
			completedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(eq(aiWatcherRuns.id, input.id));
}

export async function markCancelled(id: string, reason?: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(aiWatcherRuns)
		.set({
			status: "cancelled",
			lastErrorSubType: reason ?? null,
			completedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(eq(aiWatcherRuns.id, id));
}

/**
 * Reclaim runs whose lease has expired (the process holding the lease died
 * or crashed mid-run). Expired leases are bounced back to `queued` so they
 * can be picked up on the next claim cycle. Called from startup and from
 * the leaser's heartbeat loop.
 */
export async function reclaimExpiredLeases(options?: {
	now?: Date;
	/** Maximum attempts before a run is given up on permanently. */
	maxAttempts?: number;
}): Promise<number> {
	const now = (options?.now ?? new Date()).toISOString();
	const maxAttempts = options?.maxAttempts ?? 3;

	// First, give up on anything over the attempt ceiling.
	const failedRows = await db
		.update(aiWatcherRuns)
		.set({
			status: "expired",
			completedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
			updatedAt: now,
			lastErrorSubType: "lease_expired_max_attempts",
		})
		.where(
			and(
				inArray(aiWatcherRuns.status, ["claimed", "running"]),
				isNotNull(aiWatcherRuns.leaseExpiresAt),
				lte(aiWatcherRuns.leaseExpiresAt, now),
				sql`${aiWatcherRuns.attemptCount} >= ${maxAttempts}`,
			),
		)
		.returning();

	// Then, re-queue anything still within attempt budget.
	const requeuedRows = await db
		.update(aiWatcherRuns)
		.set({
			status: "queued",
			leaseOwner: null,
			leaseExpiresAt: null,
			claimedAt: null,
			updatedAt: now,
		})
		.where(
			and(
				inArray(aiWatcherRuns.status, ["claimed", "running"]),
				isNotNull(aiWatcherRuns.leaseExpiresAt),
				lte(aiWatcherRuns.leaseExpiresAt, now),
			),
		)
		.returning();

	return failedRows.length + requeuedRows.length;
}

export async function heartbeatRun(input: {
	id: string;
	leaseOwner: string;
	leaseDurationMs: number;
	now?: Date;
}): Promise<boolean> {
	const now = input.now ?? new Date();
	const leaseExpires = new Date(now.getTime() + input.leaseDurationMs).toISOString();
	const updated = await db
		.update(aiWatcherRuns)
		.set({ leaseExpiresAt: leaseExpires, updatedAt: now.toISOString() })
		.where(and(eq(aiWatcherRuns.id, input.id), eq(aiWatcherRuns.leaseOwner, input.leaseOwner)))
		.returning();
	return updated.length > 0;
}

export async function listRecentRunsForSession(
	sessionId: string,
	limit = 20,
): Promise<WatcherRunRecord[]> {
	const rows = await db
		.select()
		.from(aiWatcherRuns)
		.where(eq(aiWatcherRuns.sessionId, sessionId))
		.orderBy(desc(aiWatcherRuns.createdAt))
		.limit(limit);
	return rows.map(toRecord);
}

/** Snapshot of queue depth per status — used by the Phase 8 diagnostics endpoint. */
export async function queueSnapshot(): Promise<Record<WatcherRunStatus, number>> {
	const rows = await db
		.select({ status: aiWatcherRuns.status, count: sql<number>`count(*)` })
		.from(aiWatcherRuns)
		.groupBy(aiWatcherRuns.status);
	const snapshot: Record<WatcherRunStatus, number> = {
		queued: 0,
		claimed: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		expired: 0,
		cancelled: 0,
	};
	for (const r of rows) {
		snapshot[r.status as WatcherRunStatus] = Number(r.count ?? 0);
	}
	return snapshot;
}
