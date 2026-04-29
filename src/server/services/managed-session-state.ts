import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedState,
	Session,
} from "../../shared/types.js";
import { db } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema.js";
import { insertNormalizedEvents } from "./event-processor.js";
import { generateSessionName } from "./name-generator.js";

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
		// Drizzle infers `text` as `string`. The producers (supervisor
		// providers + this file) only ever stamp ManagedState members,
		// so the runtime values are always valid; this cast is the
		// boundary between the DB row type and the typed application view.
		managedState: row.managedState as ManagedState,
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
	const launchRequestId =
		input.launchRequestId ?? existingManaged?.launchRequestId ?? input.sessionId;
	const providerSessionId = input.providerSessionId ?? existingManaged?.providerSessionId ?? null;
	const providerThreadId = input.providerThreadId ?? existingManaged?.providerThreadId ?? null;
	const providerThreadTitle =
		input.providerThreadTitle ?? existingManaged?.providerThreadTitle ?? null;
	const providerSyncState =
		input.providerSyncState ?? existingManaged?.providerSyncState ?? "pending";
	const providerSyncError = input.providerSyncError ?? existingManaged?.providerSyncError ?? null;
	const lastProviderSyncAt =
		input.lastProviderSyncAt ?? existingManaged?.lastProviderSyncAt ?? null;
	const providerProtocolVersion =
		input.providerProtocolVersion ?? existingManaged?.providerProtocolVersion ?? null;
	const providerCapabilitySnapshot =
		input.providerCapabilitySnapshot ?? existingManaged?.providerCapabilitySnapshot ?? null;
	// Narrow row.managedState (Drizzle string) into the typed union — every
	// producer in the codebase only writes ManagedState members, so the
	// runtime value is always valid.
	const resolvedManagedState: ManagedState =
		input.managedState ?? (existingManaged?.managedState as ManagedState | undefined) ?? "managed";

	await db
		.insert(managedSessions)
		.values({
			sessionId: input.sessionId,
			launchRequestId,
			supervisorId,
			providerSessionId,
			providerThreadId,
			managedState: resolvedManagedState,
			correlationSource:
				input.correlationSource ?? existingManaged?.correlationSource ?? "session_id",
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
				managedState: resolvedManagedState,
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
		source: event.source ?? (event.category === "prompt" ? "managed_control" : "launch_system"),
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
	// Narrow Drizzle row's `string` to ManagedState. Every producer only
	// writes union members, so this cast is safe at the boundary.
	const resolvedManagedState: ManagedState =
		(existingManaged?.managedState as ManagedState | undefined) ?? "linked";

	await db
		.insert(managedSessions)
		.values({
			sessionId: input.sessionId,
			launchRequestId: input.launchRequestId,
			supervisorId: input.supervisorId,
			providerSessionId: existingManaged?.providerSessionId ?? input.sessionId,
			providerThreadId: existingManaged?.providerThreadId ?? null,
			managedState: resolvedManagedState,
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
				managedState: resolvedManagedState,
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

/**
 * Stamp the session row with watcher state + last-run timestamp for UI
 * badges. Broadcast happens via the caller (usually notifySessionUpdated
 * after it refreshes the session snapshot).
 *
 * Moved from `ai/ai-events.ts` (Slice AI-EVT-1) — these write to `sessions`
 * columns, which is this module's responsibility.
 */
export async function stampWatcherState(sessionId: string, state: string): Promise<void> {
	await db
		.update(sessions)
		.set({ watcherState: state, watcherLastRunAt: nowIso() })
		.where(eq(sessions.sessionId, sessionId));
}

/** Mark the last time a user prompt landed so race-control sees it. */
export async function stampUserPrompt(sessionId: string): Promise<void> {
	await db
		.update(sessions)
		.set({ watcherLastUserPromptAt: nowIso() })
		.where(eq(sessions.sessionId, sessionId));
}
