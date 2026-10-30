import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type {
	ControlAction,
	ControlActionStatus,
	ControlActionType,
	LaunchMode,
	LaunchRequest,
	LaunchableAgentType,
	SessionTemplateInput,
} from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	projects,
	sessions,
} from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { withTransaction } from "../db/with-transaction.js";
import { markAuditExpiredUnclaimed } from "./ai/dispatch-audit-service.js";
import { buildStoredCliArgs, validateAgainstSupervisor } from "./launch-compatibility.js";
import { mapLaunchRequest } from "./launch-validator.js";
import { bumpVersionAndReload } from "./projects/cache.js";
import { ownerLaunchJoin, resolveSessionOwner, sessionOwnedBy } from "./session-ownership.js";
import { getSupervisor } from "./supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";
import { parseDbTimestamp } from "./util/db-time.js";

/** A database handle: the shared one, or the transaction a caller is running inside. */
type DbHandle = ReturnType<typeof getDb>;

function nowIso() {
	return new Date().toISOString();
}

function lockExpiryIso() {
	return new Date(Date.now() + 90_000).toISOString();
}

/**
 * codex r2 F43/F44 (D10): managed-session-state.ts's upsertManagedSessionState
 * stores `launchRequestId = sessionId` when a legitimate first report omits
 * it (the "legacy fallback" shape the D6/D12 correlation check already
 * treats as healthy). That value never matches a real launch_requests.id,
 * so a plain id lookup finds nothing for those rows. When the managed
 * row's launchRequestId is exactly the session id, and no launch has that
 * id, fall back to resolving by launchCorrelationId = sessionId instead —
 * the same launch the fallback shape is standing in for.
 */
async function resolveManagedLaunch(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
	launchRequestId: string,
) {
	const [byId] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, launchRequestId))
		.limit(1);
	if (byId) return byId as typeof launchRequests.$inferSelect;
	if (launchRequestId !== sessionId) return null;
	const [byCorrelation] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, sessionId))
		.limit(1);
	return (byCorrelation ?? null) as typeof launchRequests.$inferSelect | null;
}

/**
 * Security (launch-correlation squatting): `launch.launchCorrelationId ===
 * sessionId` is satisfied by construction for ANY launch resolveManagedLaunch
 * can return — attachManagedSessionToLaunch only ever attaches a launch
 * whose own correlation id equals the session id, and the legacy
 * launchRequestId=sessionId fallback branch above looks the launch up BY
 * that same correlation id. That equality proves the launch spawned (or
 * claims to have spawned) this session; it proves nothing about who the
 * launch belongs to. Check the resolved launch's claimant (or requested
 * supervisor, pre-claim) matches the session's actual owner of record
 * before trusting launch.env or routing a new control action to it.
 */
async function launchOwnedBySessionOwner(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
	launch: typeof launchRequests.$inferSelect,
): Promise<boolean> {
	const owner = await resolveSessionOwner(db, sessionId);
	const launchOwner = launch.claimedBySupervisorId ?? launch.requestedSupervisorId ?? null;
	return !(owner !== null && launchOwner !== null && owner !== launchOwner);
}

/** The throwing form of launchOwnedBySessionOwner, for callers outside a locked transaction. */
async function assertLaunchOwnedBySessionOwner(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
	launch: typeof launchRequests.$inferSelect,
): Promise<void> {
	if (!(await launchOwnedBySessionOwner(db, sessionId, launch))) {
		throw new LaunchMismatchError();
	}
}

/** The `error` an action carries when its lock ran out before the supervisor reported: its outcome is unknown. */
export const CONTROL_TIMEOUT_ERROR = "Control action timed out waiting for supervisor completion.";

/**
 * Fails a managed session's active control action once its lock has expired,
 * and clears the lock, but only if that very action still holds it: a stale
 * expiry must never clear a lock a newer action took. Takes the handle to write
 * through: a request passes `getDb()`, a dispatch transaction passes its own
 * `tx` (every statement of a locked body must go through it).
 */
export async function expireStaleControlLock(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
) {
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed?.activeControlActionId || !managed.controlLockExpiresAt) return;
	if (new Date(managed.controlLockExpiresAt).getTime() > Date.now()) return;

	const [action] = await db
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, managed.activeControlActionId))
		.limit(1);

	const timestamp = nowIso();
	await db
		.update(controlActions)
		.set({
			status: "failed",
			error: CONTROL_TIMEOUT_ERROR,
			finishedAt: timestamp,
			updatedAt: timestamp,
		})
		// Only an action still in flight: one that reported success in the meantime stays succeeded.
		.where(
			and(
				eq(controlActions.id, managed.activeControlActionId),
				inArray(controlActions.status, ["queued", "running"]),
			),
		);

	// An AI prompt no supervisor ever claimed was never delivered: its audit row
	// says so (the one transition out of `sent` the database allows).
	if (action && isUnclaimedAiPrompt(action)) {
		await markAuditExpiredUnclaimed(db, action.id);
	}

	await db
		.update(managedSessions)
		.set({
			activeControlActionId: null,
			controlLockExpiresAt: null,
			updatedAt: timestamp,
		})
		.where(
			and(
				eq(managedSessions.sessionId, sessionId),
				eq(managedSessions.activeControlActionId, managed.activeControlActionId),
			),
		);
}

function isUnclaimedAiPrompt(action: typeof controlActions.$inferSelect): boolean {
	return (
		action.actionType === "prompt" && action.requestedBy === "ai" && action.status === "queued"
	);
}

async function expireStaleControlLocksForSupervisor(supervisorId: string) {
	const stale = await getDb()
		.select({
			sessionId: managedSessions.sessionId,
		})
		.from(managedSessions)
		.leftJoin(launchRequests, ownerLaunchJoin)
		.where(
			and(
				sessionOwnedBy(supervisorId),
				isNotNull(managedSessions.activeControlActionId),
				isNotNull(managedSessions.controlLockExpiresAt),
			),
		);

	for (const row of stale) {
		await expireStaleControlLock(getDb(), row.sessionId);
	}
}

function mapControlAction(row: typeof controlActions.$inferSelect): ControlAction {
	return {
		id: row.id,
		sessionId: row.sessionId ?? null,
		launchRequestId: row.launchRequestId ?? null,
		actionType: row.actionType as ControlActionType,
		requestedBy: row.requestedBy ?? null,
		requestedByUserId: row.requestedByUserId ?? null,
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

/**
 * An action as a reader sees it. `metadata.env` is the launch's environment and is never shown: it is
 * for the supervisor that runs the action. `metadata.prompt` is shown only when the caller has been
 * judged the session's owner (or an admin, or it is solo), and is dropped otherwise. The supervisor
 * channel (claim and update) uses the unredacted action; nothing that answers a person does.
 */
export function redactControlAction(
	action: ControlAction,
	options: { includePrompt: boolean },
): ControlAction {
	if (!action.metadata) return action;
	const { env: _env, prompt, ...rest } = action.metadata as Record<string, unknown>;
	return {
		...action,
		metadata: options.includePrompt && prompt !== undefined ? { ...rest, prompt } : rest,
	};
}

/**
 * A session's control actions for a person to read. The caller decides `includePrompt` after its own
 * owner check; the default shows no prompt, and the environment is never shown.
 */
export async function listControlActionsForSession(
	sessionId: string,
	options: { includePrompt?: boolean } = {},
) {
	const rows = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, sessionId))
		.orderBy(asc(controlActions.createdAt));
	return rows.map((row) =>
		redactControlAction(mapControlAction(row), { includePrompt: options.includePrompt === true }),
	);
}

/** Another control action holds the session's lock. Thrown only by the human-facing queue functions. */
export class ControlBusyError extends Error {
	constructor() {
		super("Another control action is already in progress for this session.");
		this.name = "ControlBusyError";
	}
}

export class SessionNotManagedError extends Error {
	constructor() {
		super("Session is not managed.");
		this.name = "SessionNotManagedError";
	}
}
export class SessionNotFoundError extends Error {
	constructor() {
		super("Session not found.");
		this.name = "SessionNotFoundError";
	}
}
export class LaunchNotFoundError extends Error {
	constructor() {
		super("Launch request not found.");
		this.name = "LaunchNotFoundError";
	}
}
export class LaunchMismatchError extends Error {
	constructor() {
		super("Launch request does not match session.");
		this.name = "LaunchMismatchError";
	}
}
export class EmptyPromptError extends Error {
	constructor() {
		super("Prompt is required.");
		this.name = "EmptyPromptError";
	}
}

export type EnqueueRefusal =
	| "not_managed"
	| "session_missing"
	| "launch_missing"
	| "launch_mismatch"
	| "control_busy";

function refusalToError(reason: EnqueueRefusal): Error {
	switch (reason) {
		case "control_busy":
			return new ControlBusyError();
		case "not_managed":
			return new SessionNotManagedError();
		case "session_missing":
			return new SessionNotFoundError();
		case "launch_missing":
			return new LaunchNotFoundError();
		case "launch_mismatch":
			return new LaunchMismatchError();
	}
}

/**
 * Takes the session's control lock for `controlActionId`, but only if nobody
 * holds it. One conditional statement, so two callers that both saw the lock
 * free can't both take it: the loser updates no row and must not insert an
 * action.
 */
export async function takeControlLock(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
	controlActionId: string,
	timestamp: string,
): Promise<boolean> {
	const taken = await tx
		.update(managedSessions)
		.set({
			activeControlActionId: controlActionId,
			controlLockExpiresAt: lockExpiryIso(),
			updatedAt: timestamp,
		})
		.where(
			and(eq(managedSessions.sessionId, sessionId), isNull(managedSessions.activeControlActionId)),
		)
		.returning({ sessionId: managedSessions.sessionId });
	return taken.length > 0;
}

/**
 * Queue a stop on `tx`: every read and write goes through it, no expected
 * outcome throws, and the lock is taken (conditionally) before the action row
 * is written.
 */
export async function enqueueStopInTx(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	input: { sessionId: string; actor: Actor; controlActionId: string },
): Promise<{ ok: true; action: ControlAction } | { ok: false; reason: EnqueueRefusal }> {
	const { sessionId, actor, controlActionId } = input;
	await expireStaleControlLock(tx, sessionId);
	const [managed] = await tx
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) return { ok: false, reason: "not_managed" };
	if (managed.activeControlActionId) return { ok: false, reason: "control_busy" };

	const stopLaunch = await resolveManagedLaunch(tx, sessionId, managed.launchRequestId);
	if (stopLaunch && !(await launchOwnedBySessionOwner(tx, sessionId, stopLaunch))) {
		return { ok: false, reason: "launch_mismatch" };
	}

	const timestamp = nowIso();
	if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp))) {
		return { ok: false, reason: "control_busy" };
	}
	const [action] = await tx
		.insert(controlActions)
		.values({
			id: controlActionId,
			sessionId,
			launchRequestId: managed.launchRequestId,
			actionType: "stop",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			status: "queued",
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	return { ok: true, action: mapControlAction(action) };
}

/** Queues a stop. With `tx` it runs inside the caller's transaction; without one it opens its own. */
export async function queueStopAction(sessionId: string, actor: Actor, tx?: DbHandle) {
	const input = { sessionId, actor, controlActionId: crypto.randomUUID() };
	const result = tx
		? await enqueueStopInTx(tx, input)
		: await withAdminLock((own) => enqueueStopInTx(own, input));
	if (!result.ok) throw refusalToError(result.reason);
	return result.action;
}

/**
 * Queue a prompt for a managed session on `tx`. Every read and write goes
 * through it and no expected outcome throws (a refusal is returned), so a
 * caller can commit its own bookkeeping after one. The lock is taken
 * conditionally with the caller's pre-generated id, and the action row is
 * inserted only if that update took a row.
 */
export async function enqueuePromptInTx(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	input: { sessionId: string; prompt: string; actor: Actor; controlActionId: string },
): Promise<{ ok: true; action: ControlAction } | { ok: false; reason: EnqueueRefusal }> {
	const { sessionId, prompt, actor, controlActionId } = input;
	await expireStaleControlLock(tx, sessionId);

	const [managed] = await tx
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) return { ok: false, reason: "not_managed" };
	if (managed.activeControlActionId) return { ok: false, reason: "control_busy" };

	const [session] = await tx
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return { ok: false, reason: "session_missing" };
	const launch = await resolveManagedLaunch(tx, sessionId, managed.launchRequestId);
	if (!launch) return { ok: false, reason: "launch_missing" };
	// D12: refuse to embed another host's launch.env in a prompt when the
	// managed row's launchRequestId points at a launch for a *different*
	// session — the last open vector once the write and read sides are
	// owner-gated. The legacy launch_request_id = session_id fallback always
	// satisfies this (a launch's own launchCorrelationId equals sessionId).
	if (launch.launchCorrelationId !== sessionId) return { ok: false, reason: "launch_mismatch" };
	if (!(await launchOwnedBySessionOwner(tx, sessionId, launch))) {
		return { ok: false, reason: "launch_mismatch" };
	}

	const timestamp = nowIso();
	if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp))) {
		return { ok: false, reason: "control_busy" };
	}
	const [action] = await tx
		.insert(controlActions)
		.values({
			id: controlActionId,
			sessionId,
			// The real launch id (F44) — managed.launchRequestId may be the
			// legacy sessionId fallback, which resolveManagedLaunch already
			// resolved to the actual launch row above.
			launchRequestId: launch.id,
			actionType: "prompt",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			status: "queued",
			metadata: {
				prompt,
				agentType: session.agentType,
				// The launch's directory (judged against the host's trusted roots when it was
				// requested), never the agent-reported session.cwd, which the agent can change.
				cwd: launch.cwd,
				// The launch's model, not the agent-reported session.model.
				model: launch.model ?? null,
				// A resume starts a new agent process, so it must carry the launch's recorded
				// privileges for the supervisor to re-apply them (null = the agent's default).
				approvalPolicy: launch.approvalPolicy ?? null,
				sandboxMode: launch.sandboxMode ?? null,
				managedState: managed.managedState,
				launchMode: launch.requestedLaunchMode,
				env: launch.env ?? {},
				// The terminal owner and the interactive bridge are the supervisor's own records,
				// found by session id on the host; nothing the agent reported is passed on.
			},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	return { ok: true, action: mapControlAction(action) };
}

/** Queues a prompt. With `tx` it runs inside the caller's transaction; without one it opens its own. */
export async function queuePromptAction(
	sessionId: string,
	prompt: string,
	actor: Actor,
	tx?: DbHandle,
) {
	const cleanPrompt = prompt.trim();
	if (!cleanPrompt) throw new EmptyPromptError();
	const input = { sessionId, prompt: cleanPrompt, actor, controlActionId: crypto.randomUUID() };
	const result = tx
		? await enqueuePromptInTx(tx, input)
		: await withAdminLock((own) => enqueuePromptInTx(own, input));
	if (!result.ok) throw refusalToError(result.reason);
	return result.action;
}

export async function retryLaunchForSession(sessionId: string, actor: Actor) {
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) throw new SessionNotManagedError();

	const original = await resolveManagedLaunch(getDb(), sessionId, managed.launchRequestId);
	if (!original) throw new Error("Original launch request not found.");
	// F47/D12: same cross-host guard queuePromptAction applies — refuse to
	// clone another host's launch.env into a fresh launch_requests row when
	// the managed row's launchRequestId points at a launch for a
	// *different* session. resolveManagedLaunch's id-lookup branch can
	// still return such a launch (it doesn't itself enforce correlation),
	// so this check must run before cloning env below.
	if (original.launchCorrelationId !== sessionId) {
		throw new Error("Launch request does not match session.");
	}
	await assertLaunchOwnedBySessionOwner(getDb(), sessionId, original);

	// A retry is a new launch, so it is judged again as one: the template's own checks, and
	// the target host's (a host that was downgraded since, or no longer has the executable,
	// must not receive it). The stored spec is rebuilt from the row so it can't drift.
	const retryTemplate = normalizeTemplateInput({
		name: "retry",
		agentType: original.agentType as LaunchableAgentType,
		cwd: original.cwd,
		baseInstructions: original.baseInstructions,
		taskPrompt: original.taskPrompt,
		model: original.model,
		approvalPolicy: original.approvalPolicy as SessionTemplateInput["approvalPolicy"],
		sandboxMode: original.sandboxMode as SessionTemplateInput["sandboxMode"],
		env: (original.env as Record<string, string>) ?? {},
	});
	const templateErrors = validateTemplateInput(retryTemplate).errors;
	if (templateErrors.length > 0) {
		throw new Error(`Launch can't be retried: ${templateErrors.join(" ")}`);
	}
	const retryHostId = original.requestedSupervisorId ?? original.resolvedSupervisorId;
	const retryHost = retryHostId ? await getSupervisor(retryHostId) : null;
	if (retryHost) {
		const { errors } = validateAgainstSupervisor(
			retryTemplate,
			retryHost,
			original.requestedLaunchMode as LaunchMode,
		);
		if (errors.length > 0) throw new Error(`Launch can't be retried: ${errors.join(" ")}`);
	} else if (original.approvalPolicy != null || original.sandboxMode != null) {
		throw new Error(
			"Launch can't be retried: its host is gone, so the approval policy and sandbox mode can't be confirmed there.",
		);
	}

	const timestamp = nowIso();
	const newCorrelationId = crypto.randomUUID();
	const [cloned] = await getDb()
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
				approvalPolicy: retryTemplate.approvalPolicy ?? null,
				sandboxMode: retryTemplate.sandboxMode ?? null,
				providerConfig: {
					...((original.launchSpec as { providerConfig?: Record<string, unknown> })
						.providerConfig ?? {}),
					cliArgs: buildStoredCliArgs(retryTemplate, original.requestedLaunchMode as LaunchMode),
				},
			},
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
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

	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: cloned.id,
			actionType: "retry",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
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

export interface QueueCleanupWorkAreaInput {
	projectId: string;
	cwd: string;
	targetSupervisorId: string;
}

/**
 * Enqueue a cleanup_workarea control_action for a scratch project. The action
 * carries the absolute cwd, the project id (for the post-success cascade), and
 * a targetSupervisorId so the session-less claim path can route it. The
 * supervisor performs the rm -rf and the server completes the cascade in
 * `updateControlAction` once the supervisor reports success.
 */
export async function queueCleanupWorkArea(
	input: QueueCleanupWorkAreaInput,
	actor: Actor,
): Promise<ControlAction> {
	const timestamp = nowIso();
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: null,
			launchRequestId: null,
			actionType: "cleanup_workarea",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			status: "queued",
			metadata: {
				projectId: input.projectId,
				cwd: input.cwd,
				targetSupervisorId: input.targetSupervisorId,
			},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	return mapControlAction(action);
}

/**
 * After the supervisor reports a cleanup_workarea success, drop the project
 * row and any sessions that were attached to it. The workspace itself is gone
 * on disk; keeping a dangling row would surprise the user. Sessions reference
 * events via FK, so events go first.
 */
async function finalizeCleanupWorkArea(projectId: string): Promise<void> {
	await withTransaction(async (tx) => {
		const projectSessions = await tx
			.select({ id: sessions.id, sessionId: sessions.sessionId })
			.from(sessions)
			.where(eq(sessions.projectId, projectId));
		for (const s of projectSessions) {
			await tx.delete(events).where(eq(events.sessionId, s.sessionId));
			await tx.delete(sessions).where(eq(sessions.id, s.id));
		}
		await tx.delete(projects).where(eq(projects.id, projectId));
	});
	// Cache invalidation only matters once the rows are durably gone; running
	// it after the tx commits keeps the cache consistent on rollback.
	await bumpVersionAndReload();
}

/**
 * An AI prompt a supervisor hasn't claimed within this long is failed at claim
 * time instead of being delivered late: the moment it was judged safe to send
 * has passed (the user or the agent has moved on). Measured against the
 * server's own created_at, so supervisor clock skew can't stretch or shrink it,
 * and kept below the 90 s control-lock expiry. Human prompts are unaffected.
 */
export const AI_PROMPT_CLAIM_TTL_MS = 60_000;

/** How many expired AI prompts one claim call will clear before it gives up and answers null. */
const MAX_EXPIRED_PER_CLAIM = 10;

function isExpiredAiPrompt(action: typeof controlActions.$inferSelect): boolean {
	if (action.actionType !== "prompt" || action.requestedBy !== "ai") return false;
	const createdMs = parseDbTimestamp(action.createdAt);
	return createdMs !== null && Date.now() - createdMs > AI_PROMPT_CLAIM_TTL_MS;
}

/** Fail an unclaimed AI prompt that outlived its TTL, release its lock and close its audit row. */
async function expireUnclaimedAiPrompt(action: typeof controlActions.$inferSelect) {
	const timestamp = nowIso();
	await getDb()
		.update(controlActions)
		.set({
			status: "failed",
			error: "Expired before a supervisor claimed it.",
			finishedAt: timestamp,
			updatedAt: timestamp,
		})
		.where(and(eq(controlActions.id, action.id), eq(controlActions.status, "queued")));
	if (action.sessionId) {
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
			.where(
				and(
					eq(managedSessions.sessionId, action.sessionId),
					eq(managedSessions.activeControlActionId, action.id),
				),
			);
	}
	await markAuditExpiredUnclaimed(getDb(), action.id);
}

export async function claimNextControlAction(supervisorId: string) {
	await expireStaleControlLocksForSupervisor(supervisorId);

	for (let expired = 0; expired <= MAX_EXPIRED_PER_CLAIM; expired += 1) {
		// Two routing channels share controlActions:
		// 1. Session-bearing actions (stop/prompt/retry/etc.) — routed by owner
		//    of record (sessionOwnedBy, session-ownership.ts).
		// 2. Session-less actions (cleanup_workarea) — pre-assigned to a host by
		//    storing supervisorId in metadata.targetSupervisorId at queue time.
		// Pick the oldest queued action across both channels.
		const sessionRow = await getDb()
			.select({ action: controlActions })
			.from(controlActions)
			.innerJoin(managedSessions, eq(managedSessions.sessionId, controlActions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(and(eq(controlActions.status, "queued"), sessionOwnedBy(supervisorId)))
			.orderBy(asc(controlActions.createdAt))
			.limit(1);

		const sessionlessRow = await getDb()
			.select()
			.from(controlActions)
			.where(
				and(
					eq(controlActions.status, "queued"),
					isNull(controlActions.sessionId),
					eq(jsonExtractText(controlActions.metadata, "$.targetSupervisorId"), supervisorId),
				),
			)
			.orderBy(asc(controlActions.createdAt))
			.limit(1);

		const sessionAction = sessionRow[0]?.action ?? null;
		const sessionlessAction = sessionlessRow[0] ?? null;

		let candidate = null;
		if (sessionAction && sessionlessAction) {
			candidate =
				sessionAction.createdAt <= sessionlessAction.createdAt ? sessionAction : sessionlessAction;
		} else {
			candidate = sessionAction ?? sessionlessAction;
		}
		if (!candidate) return null;

		if (isExpiredAiPrompt(candidate)) {
			await expireUnclaimedAiPrompt(candidate);
			continue;
		}

		const timestamp = nowIso();
		const [updated] = await getDb()
			.update(controlActions)
			.set({
				status: "running",
				claimedBySupervisorId: supervisorId,
				updatedAt: timestamp,
			})
			.where(eq(controlActions.id, candidate.id))
			.returning();
		return updated ? mapControlAction(updated) : null;
	}
	return null;
}

export async function updateControlAction(input: {
	actionId: string;
	supervisorId: string;
	status: Exclude<ControlActionStatus, "queued">;
	error?: string | null;
	metadata?: Record<string, unknown> | null;
}) {
	const [current] = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, input.actionId))
		.limit(1);
	if (!current || current.claimedBySupervisorId !== input.supervisorId) return null;

	const timestamp = nowIso();
	const [updated] = await getDb()
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
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: null,
				controlLockExpiresAt: null,
				updatedAt: timestamp,
			})
			// Only if this action still holds the lock: an attempt that timed out and finished late
			// must not free the lock of the retry that replaced it.
			.where(
				and(
					eq(managedSessions.sessionId, current.sessionId),
					eq(managedSessions.activeControlActionId, current.id),
				),
			);
	}

	if (current.actionType === "cleanup_workarea" && input.status === "succeeded") {
		const meta = (current.metadata as Record<string, unknown> | null) ?? {};
		const projectId = typeof meta.projectId === "string" ? meta.projectId : null;
		if (projectId) {
			try {
				await finalizeCleanupWorkArea(projectId);
			} catch (err) {
				console.error("[control-actions] cleanup finalize failed", err);
			}
		}
	}

	return updated ? mapControlAction(updated) : null;
}
