import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { launchRequests, managedSessions } from "../db/schema.js";
import { mapLaunchRequest } from "./launch-validator.js";
import type { LaunchRequestStatus } from "../../shared/types.js";

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

export async function linkObservedSessionToLaunch(sessionId: string, supervisorId?: string | null) {
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

	if (!row) return null;

	const timestamp = nowIso();
	const [existingManaged] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	await db
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: row.id,
			supervisorId: supervisorId ?? row.claimedBySupervisorId ?? row.requestedSupervisorId ?? "unknown",
			providerSessionId: existingManaged?.providerSessionId ?? sessionId,
			providerThreadId: existingManaged?.providerThreadId ?? null,
			managedState: existingManaged?.managedState ?? "linked",
			correlationSource: existingManaged?.correlationSource ?? "session_id",
			desiredThreadTitle: existingManaged?.desiredThreadTitle ?? null,
			providerThreadTitle: existingManaged?.providerThreadTitle ?? null,
			providerSyncState: existingManaged?.providerSyncState ?? "pending",
			providerSyncError: existingManaged?.providerSyncError ?? null,
			lastProviderSyncAt: existingManaged?.lastProviderSyncAt ?? null,
			providerProtocolVersion: existingManaged?.providerProtocolVersion ?? null,
			providerCapabilitySnapshot: existingManaged?.providerCapabilitySnapshot ?? null,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.onConflictDoUpdate({
			target: managedSessions.sessionId,
			set: {
				launchRequestId: row.id,
				supervisorId:
					supervisorId ?? row.claimedBySupervisorId ?? row.requestedSupervisorId ?? "unknown",
				providerSessionId: existingManaged?.providerSessionId ?? sessionId,
				providerThreadId: existingManaged?.providerThreadId ?? null,
				managedState: existingManaged?.managedState ?? "linked",
				correlationSource: existingManaged?.correlationSource ?? "session_id",
				desiredThreadTitle: existingManaged?.desiredThreadTitle ?? null,
				providerThreadTitle: existingManaged?.providerThreadTitle ?? null,
				providerSyncState: existingManaged?.providerSyncState ?? "pending",
				providerSyncError: existingManaged?.providerSyncError ?? null,
				lastProviderSyncAt: existingManaged?.lastProviderSyncAt ?? null,
				providerProtocolVersion: existingManaged?.providerProtocolVersion ?? null,
				providerCapabilitySnapshot: existingManaged?.providerCapabilitySnapshot ?? null,
				updatedAt: timestamp,
			},
		});

	const [updated] = await db
		.update(launchRequests)
		.set({
			status: "running",
			dispatchFinishedAt: timestamp,
			updatedAt: timestamp,
		})
		.where(eq(launchRequests.id, row.id))
		.returning();

	return updated ? mapLaunchRequest(updated) : null;
}
