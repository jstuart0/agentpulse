import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { aiWatcherRuns } from "../../db/schema.js";
import { isUniqueViolationError } from "../../db/sql-helpers.js";

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
 *
 * Race window: two concurrent callers may both observe no open run and then
 * race to INSERT. Only one INSERT wins; the loser catches the unique-violation
 * error (Postgres SQLSTATE 23505 / SQLite SQLITE_CONSTRAINT_UNIQUE), re-reads
 * the row the winner inserted, and returns it. Any other error is re-thrown.
 */
export async function enqueueRun(input: {
	sessionId: string;
	triggerEventId?: number | null;
	triggerKind: WatcherRunTriggerKind;
}): Promise<WatcherRunRecord> {
	const existing = await getOpenRunForSession(input.sessionId);
	if (existing) return existing;
	const now = new Date().toISOString();
	try {
		const [row] = await getDb()
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
	} catch (err) {
		if (isUniqueViolationError(err)) {
			// Race: another writer enqueued the same session between our SELECT and
			// INSERT. Re-read the existing open run and return it.
			const raceWinner = await getOpenRunForSession(input.sessionId);
			if (raceWinner) return raceWinner;
		}
		throw err;
	}
}

/** Find the single open (non-terminal) run for a session, if any. */
export async function getOpenRunForSession(sessionId: string): Promise<WatcherRunRecord | null> {
	const [row] = await getDb()
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
 * Attempt to claim the next queued run for processing. Implements at-most-once
 * semantics on both backends:
 *
 *   - SELECT picks the oldest queued row.
 *   - UPDATE re-checks `status = 'queued'` in the WHERE clause. On Postgres,
 *     two concurrent callers may both SELECT the same row, but only one UPDATE
 *     matches — the other gets 0 rows back and returns null.
 *   - SQLite serializes all writes, so contention is impossible; the same
 *     SELECT+UPDATE pattern works without any extra locking.
 *
 * The loser (returning null) does NOT re-loop. `RunLeaser.drain()` breaks on
 * null (see run-leaser.ts:67-73), leaving later rows for the next interval.
 * This is intentional: at-most-once beats at-least-once for AgentPulse's
 * low-contention workload.
 *
 * TODO(postgres-leaser-perf): replace SELECT+UPDATE with SELECT … FOR UPDATE
 * SKIP LOCKED in a follow-up for at-least-once contention reduction.
 */
export async function claimNextRun(input: {
	leaseOwner: string;
	leaseDurationMs: number;
	now?: Date;
}): Promise<WatcherRunRecord | null> {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const leaseExpires = new Date(now.getTime() + input.leaseDurationMs).toISOString();

	const [candidate] = await getDb()
		.select()
		.from(aiWatcherRuns)
		.where(eq(aiWatcherRuns.status, "queued"))
		.orderBy(asc(aiWatcherRuns.createdAt))
		.limit(1);
	if (!candidate) return null;

	const updated = await getDb()
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
	await getDb()
		.update(aiWatcherRuns)
		.set({ status: "running", updatedAt: now })
		.where(eq(aiWatcherRuns.id, id));
}

export async function markSucceeded(input: {
	id: string;
	proposalId?: string | null;
}): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
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
	await getDb()
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
	await getDb()
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
	const failedRows = await getDb()
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
	const requeuedRows = await getDb()
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
	const updated = await getDb()
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
	const rows = await getDb()
		.select()
		.from(aiWatcherRuns)
		.where(eq(aiWatcherRuns.sessionId, sessionId))
		.orderBy(desc(aiWatcherRuns.createdAt))
		.limit(limit);
	return rows.map(toRecord);
}

/** Snapshot of queue depth per status — used by the Phase 8 diagnostics endpoint. */
export async function queueSnapshot(): Promise<Record<WatcherRunStatus, number>> {
	const rows = await getDb()
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
