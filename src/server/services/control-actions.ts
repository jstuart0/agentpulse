import { and, asc, eq, isNotNull } from "drizzle-orm";
import type {
	ControlAction,
	ControlActionStatus,
	ControlActionType,
	LaunchRequest,
} from "../../shared/types.js";
import { db } from "../db/client.js";
import { controlActions, launchRequests, managedSessions, sessions } from "../db/schema.js";
import { mapLaunchRequest } from "./launch-validator.js";

function nowIso() {
	return new Date().toISOString();
}

function lockExpiryIso() {
	return new Date(Date.now() + 90_000).toISOString();
}

async function expireStaleControlLock(sessionId: string) {
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed?.activeControlActionId || !managed.controlLockExpiresAt) return;
	if (new Date(managed.controlLockExpiresAt).getTime() > Date.now()) return;

	const timestamp = nowIso();
	await db
		.update(controlActions)
		.set({
			status: "failed",
			error: "Control action timed out waiting for supervisor completion.",
			finishedAt: timestamp,
			updatedAt: timestamp,
		})
		.where(eq(controlActions.id, managed.activeControlActionId));

	await db
		.update(managedSessions)
		.set({
			activeControlActionId: null,
			controlLockExpiresAt: null,
			updatedAt: timestamp,
		})
		.where(eq(managedSessions.sessionId, sessionId));
}

async function expireStaleControlLocksForSupervisor(supervisorId: string) {
	const stale = await db
		.select({
			sessionId: managedSessions.sessionId,
		})
		.from(managedSessions)
		.where(
			and(
				eq(managedSessions.supervisorId, supervisorId),
				isNotNull(managedSessions.activeControlActionId),
				isNotNull(managedSessions.controlLockExpiresAt),
			),
		);

	for (const row of stale) {
		await expireStaleControlLock(row.sessionId);
	}
}

function mapControlAction(row: typeof controlActions.$inferSelect): ControlAction {
	return {
		id: row.id,
		sessionId: row.sessionId ?? null,
		launchRequestId: row.launchRequestId ?? null,
		actionType: row.actionType as ControlActionType,
		requestedBy: row.requestedBy ?? null,
		status: row.status as ControlActionStatus,
		error: row.error ?? null,
		metadata: (row.metadata as Record<string, unknown> | null) ?? null,
		idempotencyKey: row.idempotencyKey ?? null,
		claimedBySupervisorId: row.claimedBySupervisorId ?? null,
		finishedAt: row.finishedAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function listControlActionsForSession(sessionId: string) {
	const rows = await db
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, sessionId))
		.orderBy(asc(controlActions.createdAt));
	return rows.map(mapControlAction);
}

export async function queueStopAction(sessionId: string) {
	await expireStaleControlLock(sessionId);
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) throw new Error("Session is not managed.");
	if (managed.activeControlActionId) {
		throw new Error("Another control action is already in progress for this session.");
	}

	const timestamp = nowIso();
	const [action] = await db
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: managed.launchRequestId,
			actionType: "stop",
			requestedBy: "local-user",
			status: "queued",
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();

	await db
		.update(managedSessions)
		.set({
			activeControlActionId: action.id,
			controlLockExpiresAt: lockExpiryIso(),
			updatedAt: timestamp,
		})
		.where(eq(managedSessions.sessionId, sessionId));

	return mapControlAction(action);
}

export async function queuePromptAction(sessionId: string, prompt: string) {
	const cleanPrompt = prompt.trim();
	if (!cleanPrompt) throw new Error("Prompt is required.");
	await expireStaleControlLock(sessionId);

	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) throw new Error("Session is not managed.");
	if (managed.activeControlActionId) {
		throw new Error("Another control action is already in progress for this session.");
	}

	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) throw new Error("Session not found.");
	const sessionMetadata =
		session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata)
			? (session.metadata as Record<string, unknown>)
			: {};

	const [launch] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, managed.launchRequestId))
		.limit(1);
	if (!launch) throw new Error("Launch request not found.");

	const timestamp = nowIso();
	const [action] = await db
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: managed.launchRequestId,
			actionType: "prompt",
			requestedBy: "local-user",
			status: "queued",
			metadata: {
				prompt: cleanPrompt,
				agentType: session.agentType,
				cwd: session.cwd,
				model: session.model,
				managedState: managed.managedState,
				launchMode: launch.requestedLaunchMode,
				env: launch.env ?? {},
				terminalOwner:
					sessionMetadata.terminalOwner &&
					typeof sessionMetadata.terminalOwner === "object" &&
					!Array.isArray(sessionMetadata.terminalOwner)
						? (sessionMetadata.terminalOwner as Record<string, unknown>)
						: null,
				interactiveBridge:
					sessionMetadata.interactiveBridge &&
					typeof sessionMetadata.interactiveBridge === "object" &&
					!Array.isArray(sessionMetadata.interactiveBridge)
						? (sessionMetadata.interactiveBridge as Record<string, unknown>)
						: null,
			},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();

	await db
		.update(managedSessions)
		.set({
			activeControlActionId: action.id,
			controlLockExpiresAt: lockExpiryIso(),
			updatedAt: timestamp,
		})
		.where(eq(managedSessions.sessionId, sessionId));

	return mapControlAction(action);
}

export async function retryLaunchForSession(sessionId: string) {
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) throw new Error("Session is not managed.");

	const [original] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, managed.launchRequestId))
		.limit(1);
	if (!original) throw new Error("Original launch request not found.");

	const timestamp = nowIso();
	const newCorrelationId = crypto.randomUUID();
	const [cloned] = await db
		.insert(launchRequests)
		.values({
			templateId: original.templateId,
			launchCorrelationId: newCorrelationId,
			agentType: original.agentType,
			cwd: original.cwd,
			baseInstructions: original.baseInstructions,
			taskPrompt: original.taskPrompt,
			model: original.model,
			approvalPolicy: original.approvalPolicy,
			sandboxMode: original.sandboxMode,
			requestedLaunchMode: original.requestedLaunchMode,
			env: (original.env as Record<string, string>) ?? {},
			launchSpec: {
				...(original.launchSpec as Record<string, unknown>),
				launchCorrelationId: newCorrelationId,
			},
			requestedBy: "local-user",
			requestedSupervisorId: original.requestedSupervisorId,
			routingPolicy: original.routingPolicy,
			resolvedSupervisorId: original.resolvedSupervisorId,
			routingDecision: (original.routingDecision as Record<string, unknown> | null) ?? null,
			status: "validated",
			error: null,
			validationWarnings: (original.validationWarnings as string[]) ?? [],
			validationSummary: original.validationSummary,
			retryOfLaunchRequestId: original.id,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();

	const [action] = await db
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: cloned.id,
			actionType: "retry",
			requestedBy: "local-user",
			status: "succeeded",
			metadata: {
				retryOfLaunchRequestId: original.id,
				newLaunchRequestId: cloned.id,
			},
			finishedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();

	return {
		action: mapControlAction(action),
		launchRequest: mapLaunchRequest(cloned) as LaunchRequest,
	};
}

export async function claimNextControlAction(supervisorId: string) {
	await expireStaleControlLocksForSupervisor(supervisorId);
	const [row] = await db
		.select({
			action: controlActions,
		})
		.from(controlActions)
		.innerJoin(managedSessions, eq(managedSessions.sessionId, controlActions.sessionId))
		.where(and(eq(controlActions.status, "queued"), eq(managedSessions.supervisorId, supervisorId)))
		.orderBy(asc(controlActions.createdAt))
		.limit(1);

	if (!row) return null;

	const timestamp = nowIso();
	const [updated] = await db
		.update(controlActions)
		.set({
			status: "running",
			claimedBySupervisorId: supervisorId,
			updatedAt: timestamp,
		})
		.where(eq(controlActions.id, row.action.id))
		.returning();
	return updated ? mapControlAction(updated) : null;
}

export async function updateControlAction(input: {
	actionId: string;
	supervisorId: string;
	status: Exclude<ControlActionStatus, "queued">;
	error?: string | null;
	metadata?: Record<string, unknown> | null;
}) {
	const [current] = await db
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, input.actionId))
		.limit(1);
	if (!current || current.claimedBySupervisorId !== input.supervisorId) return null;

	const timestamp = nowIso();
	const [updated] = await db
		.update(controlActions)
		.set({
			status: input.status,
			error: input.error ?? null,
			metadata: input.metadata ?? current.metadata,
			finishedAt: input.status === "running" ? null : timestamp,
			updatedAt: timestamp,
		})
		.where(eq(controlActions.id, input.actionId))
		.returning();

	if (current.sessionId && input.status !== "running") {
		await db
			.update(managedSessions)
			.set({
				activeControlActionId: null,
				controlLockExpiresAt: null,
				updatedAt: timestamp,
			})
			.where(eq(managedSessions.sessionId, current.sessionId));
	}

	return updated ? mapControlAction(updated) : null;
}
