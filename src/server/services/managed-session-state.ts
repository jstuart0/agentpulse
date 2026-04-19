import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema.js";
import { generateSessionName } from "./name-generator.js";
import { insertNormalizedEvents } from "./event-processor.js";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../../shared/types.js";

function nowIso() {
	return new Date().toISOString();
}

function mapManagedSession(row: typeof managedSessions.$inferSelect): ManagedSession {
	return {
		sessionId: row.sessionId,
		launchRequestId: row.launchRequestId,
		supervisorId: row.supervisorId,
		providerSessionId: row.providerSessionId ?? null,
		providerThreadId: row.providerThreadId ?? null,
		managedState: row.managedState,
		correlationSource: row.correlationSource ?? null,
		desiredThreadTitle: row.desiredThreadTitle ?? null,
		providerThreadTitle: row.providerThreadTitle ?? null,
		providerSyncState: (row.providerSyncState as ManagedSession["providerSyncState"]) ?? "pending",
		providerSyncError: row.providerSyncError ?? null,
		lastProviderSyncAt: row.lastProviderSyncAt ?? null,
		providerProtocolVersion: row.providerProtocolVersion ?? null,
		providerCapabilitySnapshot:
			(row.providerCapabilitySnapshot as Record<string, unknown> | null) ?? null,
		activeControlActionId: row.activeControlActionId ?? null,
		controlLockExpiresAt: row.controlLockExpiresAt ?? null,
		hostName: row.hostName ?? null,
		hostAffinityReason: row.hostAffinityReason ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function getManagedSession(sessionId: string) {
	const [row] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	return row ? mapManagedSession(row) : null;
}

export async function upsertManagedSessionState(
	supervisorId: string,
	input: ManagedSessionStateInput,
): Promise<{ session: Session; managedSession: ManagedSession }> {
	const timestamp = nowIso();
	const [existingManaged] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);
	const [existingSession] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, input.sessionId))
		.limit(1);

	const sessionUpdates: Record<string, unknown> = {
		lastActivityAt: timestamp,
		status: input.status ?? "active",
	};

	if (input.cwd !== undefined) sessionUpdates.cwd = input.cwd;
	if (input.model !== undefined) sessionUpdates.model = input.model;
	if (input.metadata) {
		sessionUpdates.metadata = {
			...(existingSession?.metadata ?? {}),
			...input.metadata,
		};
	}

	if (!existingSession) {
		await db.insert(sessions).values({
			sessionId: input.sessionId,
			displayName: input.desiredThreadTitle || generateSessionName(),
			agentType: input.agentType ?? "codex_cli",
			status: (input.status ?? "active") as string,
			cwd: input.cwd ?? null,
			model: input.model ?? null,
			startedAt: timestamp,
			lastActivityAt: timestamp,
			metadata: input.metadata ?? {},
		});
	} else {
		await db.update(sessions).set(sessionUpdates).where(eq(sessions.sessionId, input.sessionId));
	}

	const [currentSession] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, input.sessionId))
		.limit(1);

	const desiredTitle = input.desiredThreadTitle ?? currentSession?.displayName ?? null;
	const [supervisor] = await db
		.select()
		.from(supervisors)
		.where(eq(supervisors.id, supervisorId))
		.limit(1);
	const launchRequestId = input.launchRequestId ?? existingManaged?.launchRequestId ?? input.sessionId;
	const providerSessionId = input.providerSessionId ?? existingManaged?.providerSessionId ?? null;
	const providerThreadId = input.providerThreadId ?? existingManaged?.providerThreadId ?? null;
	const providerThreadTitle = input.providerThreadTitle ?? existingManaged?.providerThreadTitle ?? null;
	const providerSyncState = input.providerSyncState ?? existingManaged?.providerSyncState ?? "pending";
	const providerSyncError = input.providerSyncError ?? existingManaged?.providerSyncError ?? null;
	const lastProviderSyncAt =
		input.lastProviderSyncAt ?? existingManaged?.lastProviderSyncAt ?? null;
	const providerProtocolVersion =
		input.providerProtocolVersion ?? existingManaged?.providerProtocolVersion ?? null;
	const providerCapabilitySnapshot =
		input.providerCapabilitySnapshot ?? existingManaged?.providerCapabilitySnapshot ?? null;

	await db
		.insert(managedSessions)
		.values({
			sessionId: input.sessionId,
			launchRequestId,
			supervisorId,
			providerSessionId,
			providerThreadId,
			managedState: input.managedState ?? existingManaged?.managedState ?? "managed",
			correlationSource: input.correlationSource ?? existingManaged?.correlationSource ?? "session_id",
			desiredThreadTitle: desiredTitle,
			providerThreadTitle,
			providerSyncState,
			providerSyncError,
			lastProviderSyncAt,
			providerProtocolVersion,
			providerCapabilitySnapshot,
			createdAt: timestamp,
			updatedAt: timestamp,
			hostName: existingManaged?.hostName ?? supervisor?.hostName ?? null,
			hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
		})
		.onConflictDoUpdate({
			target: managedSessions.sessionId,
			set: {
				launchRequestId,
				supervisorId,
				providerSessionId,
				providerThreadId,
				managedState: input.managedState ?? existingManaged?.managedState ?? "managed",
				correlationSource:
					input.correlationSource ?? existingManaged?.correlationSource ?? "session_id",
				desiredThreadTitle: desiredTitle,
				providerThreadTitle,
				providerSyncState,
				providerSyncError,
				lastProviderSyncAt,
				providerProtocolVersion,
				providerCapabilitySnapshot,
				hostName: existingManaged?.hostName ?? supervisor?.hostName ?? null,
				hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
				updatedAt: timestamp,
			},
		});

	const [managedRow] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	return {
		session: {
			...(currentSession as Session),
			managedSession: managedRow ? mapManagedSession(managedRow) : null,
		},
		managedSession: mapManagedSession(managedRow!),
	};
}

export async function appendManagedSessionEvents(
	sessionId: string,
	events: ManagedSessionEventInput[],
) {
	const normalized = events.map((event) => ({
		eventType: event.eventType,
		category: event.category,
		content: event.content ?? null,
		isNoise: event.isNoise ?? false,
		providerEventType: event.providerEventType ?? null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: event.rawPayload ?? {},
	}));
	return insertNormalizedEvents(sessionId, normalized);
}

export async function attachManagedSessionToLaunch(input: {
	sessionId: string;
	launchRequestId: string;
	supervisorId: string;
	correlationSource?: string | null;
}) {
	const timestamp = nowIso();
	const [existingManaged] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	await db
		.insert(managedSessions)
		.values({
			sessionId: input.sessionId,
			launchRequestId: input.launchRequestId,
			supervisorId: input.supervisorId,
			providerSessionId: existingManaged?.providerSessionId ?? input.sessionId,
			providerThreadId: existingManaged?.providerThreadId ?? null,
			managedState: existingManaged?.managedState ?? "linked",
			correlationSource: input.correlationSource ?? existingManaged?.correlationSource ?? "session_id",
			desiredThreadTitle: existingManaged?.desiredThreadTitle ?? null,
			providerThreadTitle: existingManaged?.providerThreadTitle ?? null,
			providerSyncState: existingManaged?.providerSyncState ?? "pending",
			providerSyncError: existingManaged?.providerSyncError ?? null,
			lastProviderSyncAt: existingManaged?.lastProviderSyncAt ?? null,
			providerProtocolVersion: existingManaged?.providerProtocolVersion ?? null,
			providerCapabilitySnapshot: existingManaged?.providerCapabilitySnapshot ?? null,
			hostName: existingManaged?.hostName ?? null,
			hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.onConflictDoUpdate({
			target: managedSessions.sessionId,
			set: {
				launchRequestId: input.launchRequestId,
				supervisorId: input.supervisorId,
				providerSessionId: existingManaged?.providerSessionId ?? input.sessionId,
				providerThreadId: existingManaged?.providerThreadId ?? null,
				managedState: existingManaged?.managedState ?? "linked",
				correlationSource:
					input.correlationSource ?? existingManaged?.correlationSource ?? "session_id",
				desiredThreadTitle: existingManaged?.desiredThreadTitle ?? null,
				providerThreadTitle: existingManaged?.providerThreadTitle ?? null,
				providerSyncState: existingManaged?.providerSyncState ?? "pending",
				providerSyncError: existingManaged?.providerSyncError ?? null,
				lastProviderSyncAt: existingManaged?.lastProviderSyncAt ?? null,
				providerProtocolVersion: existingManaged?.providerProtocolVersion ?? null,
				providerCapabilitySnapshot: existingManaged?.providerCapabilitySnapshot ?? null,
				hostName: existingManaged?.hostName ?? null,
				hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
				updatedAt: timestamp,
			},
		});

	const [managedRow] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	return managedRow ? mapManagedSession(managedRow) : null;
}

export async function listManagedSessionsNeedingSync(supervisorId: string) {
	const rows = await db
		.select()
		.from(managedSessions)
		.where(
			and(
				eq(managedSessions.supervisorId, supervisorId),
				isNotNull(managedSessions.desiredThreadTitle),
				or(
					isNull(managedSessions.providerThreadTitle),
					ne(managedSessions.desiredThreadTitle, managedSessions.providerThreadTitle),
				),
			),
		);

	return rows.map(mapManagedSession);
}

export { mapManagedSession };
