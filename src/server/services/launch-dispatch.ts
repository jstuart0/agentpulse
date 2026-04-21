import { and, asc, eq, inArray } from "drizzle-orm";
import type { LaunchRequest, LaunchRequestStatus } from "../../shared/types.js";
import { db } from "../db/client.js";
import { launchRequests } from "../db/schema.js";
import { resolveObservedSessionCorrelation } from "./correlation-resolver.js";
import { mapLaunchRequest } from "./launch-validator.js";
import { attachManagedSessionToLaunch } from "./managed-session-state.js";

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

	return markLaunchRunning(resolution.launchRequest.id);
}
