import { and, asc, eq, inArray } from "drizzle-orm";
import type { LaunchRequest, LaunchRequestStatus } from "../../shared/types.js";
import { db } from "../db/client.js";
import { launchRequests, sessions } from "../db/schema.js";
import { applyAskInitiatedWatcher } from "./ai/auto-watcher.js";
import { resolveObservedSessionCorrelation } from "./correlation-resolver.js";
import { markSessionFailed } from "./event-processor.js";
import { mapLaunchRequest } from "./launch-validator.js";
import { attachManagedSessionToLaunch } from "./managed-session-state.js";

const PROVENANCE_KEYS = ["aiInitiated", "askThreadId"] as const;

// Auto-generated adjective-noun shape from name-generator.ts. We only
// rewrite the displayName when it still matches this pattern — once a
// user (or a custom rename) has changed it, we leave it alone.
const AUTO_NAME_PATTERN = /^[a-z]+-[a-z]+$/;

/**
 * If the just-correlated launch_request carries a slice-3 desired display
 * name, rewrite sessions.displayName — but only when the existing name is
 * still in adjective-noun shape. Idempotent: a second call after the rename
 * sees the new name (which no longer matches the pattern) and is a no-op.
 */
export async function applyDesiredDisplayName(
	sessionId: string,
	launchRequest: LaunchRequest,
): Promise<void> {
	const desired = launchRequest.desiredDisplayName;
	if (!desired) return;

	const [row] = await db
		.select({ displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	if (!row.displayName || !AUTO_NAME_PATTERN.test(row.displayName)) return;
	if (row.displayName === desired) return;

	await db.update(sessions).set({ displayName: desired }).where(eq(sessions.sessionId, sessionId));
}

/**
 * Copy any provenance hints stamped on launch_requests.metadata onto the
 * just-correlated session row. Idempotent: a re-correlation never clobbers
 * existing keys with stale values, so manually edited session metadata stays
 * intact. Returns silently when there is nothing to merge.
 */
async function applyLaunchProvenanceToSession(
	sessionId: string,
	launchMetadata: Record<string, unknown> | null,
) {
	if (!launchMetadata) return;
	const provenance: Record<string, unknown> = {};
	for (const key of PROVENANCE_KEYS) {
		const value = launchMetadata[key];
		if (value !== undefined && value !== null) provenance[key] = value;
	}
	if (Object.keys(provenance).length === 0) return;

	const [row] = await db
		.select({ metadata: sessions.metadata })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return;

	const existing = (row.metadata as Record<string, unknown> | null) ?? {};
	let changed = false;
	const merged: Record<string, unknown> = { ...existing };
	for (const [k, v] of Object.entries(provenance)) {
		if (existing[k] === undefined) {
			merged[k] = v;
			changed = true;
		}
	}
	if (!changed) return;

	await db.update(sessions).set({ metadata: merged }).where(eq(sessions.sessionId, sessionId));
}

function nowIso() {
	return new Date().toISOString();
}

function awaitingDeadlineIso() {
	return new Date(Date.now() + 60_000).toISOString();
}

export async function claimNextLaunchRequest(supervisorId: string) {
	const [row] = await db
		.select()
		.from(launchRequests)
		.where(
			and(
				eq(launchRequests.requestedSupervisorId, supervisorId),
				eq(launchRequests.status, "validated"),
			),
		)
		.orderBy(asc(launchRequests.createdAt))
		.limit(1);

	if (!row) return null;

	const claimToken = crypto.randomUUID();
	const now = nowIso();
	const [claimed] = await db
		.update(launchRequests)
		.set({
			status: "queued",
			claimedBySupervisorId: supervisorId,
			claimToken,
			updatedAt: now,
		})
		.where(eq(launchRequests.id, row.id))
		.returning();

	return claimed ? mapLaunchRequest(claimed) : null;
}

export async function updateLaunchDispatchStatus(input: {
	supervisorId: string;
	launchId: string;
	status: LaunchRequestStatus;
	error?: string | null;
	pid?: number | null;
	providerLaunchMetadata?: Record<string, unknown> | null;
}) {
	const now = nowIso();
	const [row] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, input.launchId))
		.limit(1);
	if (!row || row.claimedBySupervisorId !== input.supervisorId) return null;

	const updates: Record<string, unknown> = {
		status: input.status,
		error: input.error ?? null,
		updatedAt: now,
	};

	if (input.status === "launching") {
		updates.dispatchStartedAt = now;
	}
	if (input.status === "awaiting_session") {
		updates.awaitingSessionDeadlineAt = awaitingDeadlineIso();
		updates.pid = input.pid ?? null;
		updates.providerLaunchMetadata = input.providerLaunchMetadata ?? {};
	}
	if (input.status === "running") {
		updates.dispatchFinishedAt = now;
		updates.pid = input.pid ?? row.pid ?? null;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}
	if (input.status === "completed") {
		updates.dispatchFinishedAt = now;
		updates.pid = input.pid ?? row.pid ?? null;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}
	if (input.status === "failed" || input.status === "cancelled") {
		updates.dispatchFinishedAt = now;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}

	const [updated] = await db
		.update(launchRequests)
		.set(updates)
		.where(eq(launchRequests.id, input.launchId))
		.returning();

	// P3: propagate launch failure to the correlated session so
	// sessions.status = "failed" is written via event-processor.ts,
	// the integration point Slice 6 alert-rule evaluation hooks into.
	if (input.status === "failed" && updated?.launchCorrelationId) {
		await markSessionFailed(updated.launchCorrelationId).catch((err) => {
			console.warn("[launch-dispatch] markSessionFailed skipped:", err);
		});
	}

	return updated ? mapLaunchRequest(updated) : null;
}

export async function findPendingLaunchForObservedSession(sessionId: string) {
	const [row] = await db
		.select()
		.from(launchRequests)
		.where(
			and(
				eq(launchRequests.launchCorrelationId, sessionId),
				inArray(launchRequests.status, ["validated", "queued", "launching", "awaiting_session"]),
			),
		)
		.limit(1);

	return row ? mapLaunchRequest(row) : null;
}

export async function markLaunchRunning(launchId: string) {
	const timestamp = nowIso();
	const [updated] = await db
		.update(launchRequests)
		.set({
			status: "running",
			dispatchFinishedAt: timestamp,
			updatedAt: timestamp,
		})
		.where(eq(launchRequests.id, launchId))
		.returning();

	return updated ? mapLaunchRequest(updated) : null;
}

/**
 * WS1 ownership contract. Given an observed session id, resolve the
 * pending launch it matches (pure), attach the managed-session row (via
 * the managed-session-state writer), and transition the launch to
 * `running` (this file's own writer). All launch-status transitions for
 * observed correlation live here — routes and hook processors don't
 * compose these writes directly.
 */
export async function associateObservedSession(input: {
	sessionId: string;
	supervisorId?: string | null;
}): Promise<LaunchRequest | null> {
	const resolution = await resolveObservedSessionCorrelation(
		input.sessionId,
		input.supervisorId ?? null,
	);
	if (!resolution) return null;

	await attachManagedSessionToLaunch({
		sessionId: input.sessionId,
		launchRequestId: resolution.launchRequest.id,
		supervisorId: resolution.resolvedSupervisorId,
		correlationSource: "session_id",
	});

	await applyLaunchProvenanceToSession(input.sessionId, resolution.launchRequest.metadata);
	await applyDesiredDisplayName(input.sessionId, resolution.launchRequest);
	await applyAskInitiatedWatcher(input.sessionId, resolution.launchRequest.metadata);

	return markLaunchRunning(resolution.launchRequest.id);
}
