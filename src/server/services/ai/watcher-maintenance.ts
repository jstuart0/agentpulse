/**
 * Boot-time upkeep for the watcher tables.
 *
 * Two entry points:
 *  - runWatcherMaintenanceOnce(): a one-shot, guarded by a settings marker. It
 *    deletes the trigger-less no-op runs the old every-event listener left
 *    behind, abandons orphaned pending proposals, converts `auto` configs to
 *    `ask_on_risk` (auto now needs a human confirmation), and supersedes every
 *    open HITL (nothing created before the release may go live on deploy).
 *    IRREVERSIBLE: deleted rows and converted policies are not restored.
 *  - sweepWatcherOnStart(): idempotent reconciliation on every runner start.
 *
 * It lives here (not in drizzle migrations) because legacy-init SQLite installs
 * never run Drizzle migrations, so a DELETE in 0012 would miss them.
 */
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
	aiDispatchAudit,
	aiHitlRequests,
	aiWatcherReports,
	aiWatcherRuns,
	controlActions,
	settings,
	watcherConfigs,
	watcherProposals,
} from "../../db/schema/index.js";
import { upsertSetting } from "../settings-service.js";
import { parseDbTimestamp } from "../util/db-time.js";
import { expireOverdueHitl } from "./hitl-service.js";

export const WATCHER_CLEANUP_MARKER_KEY = "ai.maintenance.watcherCleanupV1";

const RUN_DELETE_BATCH_SIZE = 1_000;
const OPEN_RUN_STATUSES = ["queued", "claimed", "running"];
const ORPHANED_PROPOSAL_AGE_MS = 60 * 60 * 1000;
const PENDING_AUDIT_RECONCILE_AGE_MS = 5 * 60 * 1000;

export interface WatcherMaintenanceResult {
	deletedRuns: number;
	keptByProposalWindow: number;
	abandonedProposals: number;
	autoConverted: number;
	hitlsSuperseded: number;
	at: string;
}

/** Runs the one-shot cleanup unless its marker is set. Returns the counts, or null when it already ran. */
export async function runWatcherMaintenanceOnce(): Promise<WatcherMaintenanceResult | null> {
	const [marker] = await getDb()
		.select({ key: settings.key })
		.from(settings)
		.where(eq(settings.key, WATCHER_CLEANUP_MARKER_KEY))
		.limit(1);
	if (marker) return null;

	const { deleted, kept } = await deleteNoOpRuns();
	const abandonedProposals = await abandonOrphanedPendingProposals(ORPHANED_PROPOSAL_AGE_MS);
	const autoConverted = await convertAutoConfigs();
	const hitlsSuperseded = await supersedeAllOpenHitl();

	const result: WatcherMaintenanceResult = {
		deletedRuns: deleted,
		keptByProposalWindow: kept,
		abandonedProposals,
		autoConverted,
		hitlsSuperseded,
		at: new Date().toISOString(),
	};
	await upsertSetting(WATCHER_CLEANUP_MARKER_KEY, result, { allowProtected: true });
	console.log(JSON.stringify({ kind: "watcher_maintenance", ...result }));
	return result;
}

/**
 * Deletes succeeded, trigger-less manual runs that did no work. A run is kept
 * when its session has a proposal created inside the run's own claimed..
 * completed window (it made the proposal but never recorded it) and when the
 * window can't be determined. The window test is done in JS because SQLite
 * timestamp formats are mixed. Paged by id so kept rows aren't re-read.
 */
async function deleteNoOpRuns(): Promise<{ deleted: number; kept: number }> {
	const db = getDb();
	let deleted = 0;
	let kept = 0;
	let afterId = "";
	for (;;) {
		const batch = await db
			.select({
				id: aiWatcherRuns.id,
				sessionId: aiWatcherRuns.sessionId,
				claimedAt: aiWatcherRuns.claimedAt,
				completedAt: aiWatcherRuns.completedAt,
			})
			.from(aiWatcherRuns)
			.where(
				and(
					eq(aiWatcherRuns.triggerKind, "manual"),
					isNull(aiWatcherRuns.triggerEventId),
					isNull(aiWatcherRuns.proposalId),
					eq(aiWatcherRuns.status, "succeeded"),
					gt(aiWatcherRuns.id, afterId),
				),
			)
			.orderBy(asc(aiWatcherRuns.id))
			.limit(RUN_DELETE_BATCH_SIZE);
		if (batch.length === 0) break;
		afterId = batch[batch.length - 1].id;

		const sessionIds = [...new Set(batch.map((r) => r.sessionId))];
		const proposalRows = await db
			.select({ sessionId: watcherProposals.sessionId, createdAt: watcherProposals.createdAt })
			.from(watcherProposals)
			.where(inArray(watcherProposals.sessionId, sessionIds));
		const proposalTimes = new Map<string, number[]>();
		for (const row of proposalRows) {
			const ms = parseDbTimestamp(row.createdAt);
			if (ms === null) continue;
			const list = proposalTimes.get(row.sessionId) ?? [];
			list.push(ms);
			proposalTimes.set(row.sessionId, list);
		}

		const doomed: string[] = [];
		for (const run of batch) {
			const claimedMs = run.claimedAt ? parseDbTimestamp(run.claimedAt) : null;
			const completedMs = run.completedAt ? parseDbTimestamp(run.completedAt) : null;
			if (claimedMs === null || completedMs === null) {
				kept += 1;
				continue;
			}
			const inWindow = (proposalTimes.get(run.sessionId) ?? []).some(
				(ms) => ms >= claimedMs && ms <= completedMs,
			);
			if (inWindow) {
				kept += 1;
			} else {
				doomed.push(run.id);
			}
		}
		if (doomed.length > 0) {
			await db.delete(aiWatcherRuns).where(inArray(aiWatcherRuns.id, doomed));
			deleted += doomed.length;
		}
		if (batch.length < RUN_DELETE_BATCH_SIZE) break;
	}
	return { deleted, kept };
}

/**
 * Cancels `pending` proposals older than `olderThanMs` whose session has no
 * open run: the process that was producing them is gone.
 */
export async function abandonOrphanedPendingProposals(olderThanMs: number): Promise<number> {
	const db = getDb();
	const pending = await db
		.select({
			id: watcherProposals.id,
			sessionId: watcherProposals.sessionId,
			createdAt: watcherProposals.createdAt,
		})
		.from(watcherProposals)
		.where(eq(watcherProposals.state, "pending"));
	const cutoff = Date.now() - olderThanMs;
	const stale = pending.filter((p) => {
		const ms = parseDbTimestamp(p.createdAt);
		return ms !== null && ms < cutoff;
	});
	if (stale.length === 0) return 0;

	const sessionIds = [...new Set(stale.map((p) => p.sessionId))];
	const openRuns = await db
		.select({ sessionId: aiWatcherRuns.sessionId })
		.from(aiWatcherRuns)
		.where(
			and(
				inArray(aiWatcherRuns.sessionId, sessionIds),
				inArray(aiWatcherRuns.status, OPEN_RUN_STATUSES),
			),
		);
	const sessionsWithOpenRun = new Set(openRuns.map((r) => r.sessionId));
	const orphaned = stale.filter((p) => !sessionsWithOpenRun.has(p.sessionId)).map((p) => p.id);
	if (orphaned.length === 0) return 0;

	const rows = await db
		.update(watcherProposals)
		.set({
			state: "cancelled",
			errorSubType: "abandoned",
			updatedAt: new Date().toISOString(),
		})
		.where(and(inArray(watcherProposals.id, orphaned), eq(watcherProposals.state, "pending")))
		.returning({ id: watcherProposals.id });
	return rows.length;
}

/** `auto` now needs a human confirmation; existing rows drop to ask_on_risk unconfirmed. */
async function convertAutoConfigs(): Promise<number> {
	const rows = await getDb()
		.update(watcherConfigs)
		.set({
			policy: "ask_on_risk",
			autoConfirmedAt: null,
			autoConfirmedBy: null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(watcherConfigs.policy, "auto"))
		.returning({ sessionId: watcherConfigs.sessionId });
	return rows.length;
}

async function supersedeAllOpenHitl(): Promise<number> {
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status: "superseded", updatedAt: new Date().toISOString() })
		.where(eq(aiHitlRequests.status, "awaiting_reply"))
		.returning({ id: aiHitlRequests.id });
	return rows.length;
}

export interface WatcherSweepResult {
	abandonedProposals: number;
	abandonedReports: number;
	timedOutHitl: number;
	reconciledAudit: number;
}

/**
 * Runs on every runner start, before the leaser. The deployment is
 * single-replica, so a `claimed` report at this point can only belong to a
 * process that no longer exists, whatever its age.
 */
export async function sweepWatcherOnStart(): Promise<WatcherSweepResult> {
	const abandonedProposals = await abandonOrphanedPendingProposals(ORPHANED_PROPOSAL_AGE_MS);
	const abandonedReports = await abandonClaimedReports();
	const timedOutHitl = await expireOverdueHitl();
	const reconciledAudit = await reconcilePendingDispatchAudit();
	return { abandonedProposals, abandonedReports, timedOutHitl, reconciledAudit };
}

async function abandonClaimedReports(): Promise<number> {
	const rows = await getDb()
		.update(aiWatcherReports)
		.set({ status: "failed", failureCode: "abandoned" })
		.where(eq(aiWatcherReports.status, "claimed"))
		.returning({ id: aiWatcherReports.id });
	return rows.length;
}

/**
 * A committed `pending` audit row older than five minutes means a dispatch
 * died between its intent row and its outcome. It was sent if its control
 * action exists, else it failed.
 */
export async function reconcilePendingDispatchAudit(): Promise<number> {
	const db = getDb();
	const pending = await db
		.select({
			id: aiDispatchAudit.id,
			createdAt: aiDispatchAudit.createdAt,
			controlActionId: aiDispatchAudit.controlActionId,
		})
		.from(aiDispatchAudit)
		.where(eq(aiDispatchAudit.outcome, "pending"));
	const cutoff = Date.now() - PENDING_AUDIT_RECONCILE_AGE_MS;
	const stale = pending.filter((p) => {
		const ms = parseDbTimestamp(p.createdAt);
		return ms !== null && ms < cutoff;
	});
	if (stale.length === 0) return 0;

	const actionIds = stale.map((p) => p.controlActionId).filter((id): id is string => id !== null);
	const existing =
		actionIds.length === 0
			? []
			: await db
					.select({ id: controlActions.id })
					.from(controlActions)
					.where(inArray(controlActions.id, actionIds));
	const existingIds = new Set(existing.map((r) => r.id));

	const completedAt = new Date().toISOString();
	let reconciled = 0;
	for (const row of stale) {
		const sent = row.controlActionId !== null && existingIds.has(row.controlActionId);
		const updated = await db
			.update(aiDispatchAudit)
			.set(
				sent
					? { outcome: "sent", completedAt }
					: { outcome: "failed", refusalCode: "abandoned", completedAt },
			)
			.where(and(eq(aiDispatchAudit.id, row.id), eq(aiDispatchAudit.outcome, "pending")))
			.returning({ id: aiDispatchAudit.id });
		reconciled += updated.length;
	}
	return reconciled;
}
