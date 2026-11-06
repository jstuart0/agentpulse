import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { CLAUDE_STOP, CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import {
	CLAUDE_STOP_UPGRADE_MESSAGE,
	CONTROL_TIMEOUT_ERROR,
	HOST_UPGRADE_REQUIRED_MESSAGE,
} from "../../shared/managed-messages.js";
import {
	RESUMES_SESSIONS,
	type ResumeKind,
	SESSION_RESUMED_CONTENT,
	SESSION_RESUMED_EVENT_TYPE,
	resumeFailureMessage,
} from "../../shared/session-resume.js";
import {
	FINISHED_LAUNCH_STATUSES,
	STOP_NOT_SUPPORTED_MESSAGE,
	STOP_RUNTIMES,
	type StopRuntime,
	TERMINAL_MANAGED_STATES,
	isClaudeStopRuntime,
} from "../../shared/stop-runtime.js";
import type {
	ControlAction,
	ControlActionStatus,
	ControlActionType,
	LaunchMode,
	LaunchRequest,
	LaunchableAgentType,
	ManagedState,
	SessionTemplateInput,
} from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { OwnerDisabledError, OwnerNotFoundError } from "../auth/owner-state.js";
import { config } from "../config.js";
import { isInsideTransaction, withAdminLock } from "../db/admin-lock.js";
import { afterCommit } from "../db/after-commit.js";
import { getDb } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	projects,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { withTransaction } from "../db/with-transaction.js";
import { requestWsRevalidation } from "../ws/revalidation.js";
import { CONTINUABLE_MANAGED_STATES } from "./ai/continuability.js";
import { markAuditExpiredUnclaimed } from "./ai/dispatch-audit-service.js";
import { BindRefusal } from "./bind-refusal.js";
import { fenceApprovalsForStop } from "./codex-approvals-fence.js";
import { type ClosedApproval, runApprovalClosedEffects } from "./codex-approvals.js";
import { buildStoredCliArgs, validateAgainstSupervisor } from "./launch-compatibility.js";
import { mapLaunchRequest } from "./launch-validator.js";
import { notifySessionUpdated } from "./notifier.js";
import { bumpVersionAndReload } from "./projects/cache.js";
import { assignTakeoverOwner } from "./session-owner-admin.js";
import {
	getSessionOwnerHostStates,
	ownerLaunchJoin,
	releaseObservedBinding,
	resolveSessionOwner,
	sessionOwnedBy,
} from "./session-ownership.js";
import { withCapabilityDefaults } from "./supervisor-capabilities.js";
import { getSupervisor } from "./supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";
import { parseDbTimestamp } from "./util/db-time.js";

/** A database handle: the shared one, or the transaction a caller is running inside. */
type DbHandle = ReturnType<typeof getDb>;

/** Epoch milliseconds; tests inject one where a control path needs to move time. */
type Clock = () => number;

function nowIso(clock: Clock = Date.now) {
	return new Date(clock()).toISOString();
}

function lockExpiryIso(clock: Clock = Date.now) {
	return new Date(clock() + 90_000).toISOString();
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
export async function resolveManagedLaunch(
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
export async function launchOwnedBySessionOwner(
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
	clock: Clock = Date.now,
) {
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed?.activeControlActionId || !managed.controlLockExpiresAt) return;
	if (new Date(managed.controlLockExpiresAt).getTime() > clock()) return;

	const [action] = await db
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, managed.activeControlActionId))
		.limit(1);

	// A resume that timed out isn't just failed: its rows are settled with it, in one transaction with
	// the action's status, wherever the expiry was reached from.
	if (
		action?.actionType === "resume" &&
		(action.status === "queued" || action.status === "running")
	) {
		const settle = (handle: unknown) => settleExpiredResume(handle, managed, action);
		if (isInsideTransaction() || db !== getDb()) {
			await settle(db);
		} else {
			await withTransaction(settle);
		}
		return;
	}

	const timestamp = nowIso(clock);
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

// ── resume actions: how they end (AGEN-115, D10, D14) ───────────────────────

/** What `failResumeAction` and `completeResumeAction` report: nothing changed, or the session whose rows moved. */
export type ResumeSettle =
	| { settled: false }
	| { settled: true; sessionId: string; outcome: "failed" | "succeeded" };

interface ResumeActionRef {
	id: string;
	sessionId: string | null;
	launchRequestId: string | null;
	metadata?: unknown;
}

/** Test seam: runs after the settle's writes, inside its transaction. */
interface ResumeSettleDeps {
	afterWrites?: (tx: unknown) => Promise<void>;
}

function resumeKindOf(action: ResumeActionRef): ResumeKind {
	return (action.metadata as { resumeKind?: unknown } | null)?.resumeKind === "recovery"
		? "recovery"
		: "takeover";
}

/**
 * Tells everyone a resume action's rows moved: one `session_updated` and one socket revalidation. A failure
 * to announce is logged and never undoes the settle.
 */
async function announceResumeSettled(sessionId: string): Promise<void> {
	try {
		const [row] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (row) notifySessionUpdated(row);
		await requestWsRevalidation();
	} catch (error) {
		console.error(
			JSON.stringify({
				kind: "resume_announce_failed",
				level: "error",
				error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
			}),
		);
	}
}

async function inTransactionOf<T>(handle: unknown | null, fn: (tx: any) => Promise<T>): Promise<T> {
	return handle ? fn(handle) : withTransaction(fn);
}

/**
 * Ends a `resume` action as failed, and settles its rows: a takeover releases the carrier launch and the
 * managed row (the session and its events are untouched); a recovery leaves the degraded row as it was.
 * Every ending of a resume goes through here or `completeResumeAction`. It begins with a guarded update of
 * the action (still queued or running), so racing paths produce one outcome: the loser changes nothing.
 * `handle` is the caller's transaction, or null to open one; the signals are sent once the transaction
 * has committed (when the caller owns it, after the caller's own commit, by the next flush).
 */
export async function failResumeAction(
	handle: unknown | null,
	action: ResumeActionRef,
	reason: string,
	deps: ResumeSettleDeps = {},
): Promise<ResumeSettle> {
	const outcome = await inTransactionOf(handle, async (tx): Promise<ResumeSettle> => {
		const timestamp = nowIso();
		const flipped = await tx
			.update(controlActions)
			.set({ status: "failed", error: reason, finishedAt: timestamp, updatedAt: timestamp })
			.where(
				and(
					eq(controlActions.id, action.id),
					inArray(controlActions.status, ["queued", "running"]),
				),
			)
			.returning({ id: controlActions.id });
		if (flipped.length === 0) return { settled: false };
		const sessionId = action.sessionId;
		if (!sessionId) return { settled: false };
		if (resumeKindOf(action) === "takeover" && action.launchRequestId) {
			await releaseObservedBinding(tx, {
				sessionId,
				launchRequestId: action.launchRequestId,
				reason,
			});
		}
		// Frees the lock if the row survives (a recovery, or a takeover whose row names another launch).
		await tx
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
			.where(
				and(
					eq(managedSessions.sessionId, sessionId),
					eq(managedSessions.activeControlActionId, action.id),
				),
			);
		await deps.afterWrites?.(tx);
		return { settled: true, sessionId, outcome: "failed" };
	});
	await announceAfterSettle(handle, outcome);
	return outcome;
}

/**
 * The signals for a settle go out once the transaction it ran in has committed: at once when this call
 * opened (and so already committed) it, else after the caller's own commit, and never if that rolls back.
 */
async function announceAfterSettle(handle: unknown | null, outcome: ResumeSettle): Promise<void> {
	if (!outcome.settled) return;
	const announce = () => announceResumeSettled(outcome.sessionId);
	if (handle === null || !afterCommit(announce)) await announce();
}

/** The fixed words of the permission wait that survive a resume: approval ids are rows of ours, native ids died with the process. */
function waitAfterResume(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
	const wait = metadata.permissionWait as { ids?: unknown } | undefined;
	if (!wait || typeof wait !== "object") return undefined;
	const ids = (Array.isArray(wait.ids) ? wait.ids : []).filter(
		(id): id is string => typeof id === "string" && id.startsWith("approval:"),
	);
	return ids.length > 0 ? { ...wait, ids, anon: 0 } : undefined;
}

/**
 * Ends a `resume` action as succeeded and brings the session back, in one transaction: only if the managed
 * row names this launch and the action is still open (else nothing changes). The ended state is cleared
 * (`endedAt`, `status`, the working flag, the turn start, `endedByEvent`), `managedResumeAt` fences later
 * `SessionEnd` hooks, a native permission wait left by the dead process is dropped (approval waits are
 * ours and stay), an unowned session gets its owner (a takeover with `assignOwner`; never overwriting one,
 * and a disabled assignee leaves it unowned and is logged), and a fixed-words `ManagedSessionResumed` event
 * is written. A write that matches no row throws and rolls the whole settle back.
 */
export async function completeResumeAction(
	handle: unknown | null,
	action: ResumeActionRef,
	deps: ResumeSettleDeps = {},
): Promise<ResumeSettle> {
	const outcome = await inTransactionOf(handle, async (tx): Promise<ResumeSettle> => {
		const sessionId = action.sessionId;
		if (!sessionId) return { settled: false };
		const [managed] = await tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1);
		// A takeover's launch row always matches the managed row's, so the state is what says the host did
		// its part: only a row the host reported `managed` has worked.
		if (
			!managed ||
			managed.launchRequestId !== action.launchRequestId ||
			managed.managedState !== "managed"
		) {
			return { settled: false };
		}

		const timestamp = nowIso();
		const flipped = await tx
			.update(controlActions)
			.set({ status: "succeeded", error: null, finishedAt: timestamp, updatedAt: timestamp })
			.where(
				and(
					eq(controlActions.id, action.id),
					inArray(controlActions.status, ["queued", "running"]),
				),
			)
			.returning({ id: controlActions.id });
		if (flipped.length === 0) return { settled: false };

		const read = tx
			.select({
				metadata: sessions.metadata,
				semanticStatus: sessions.semanticStatus,
				ownerUserId: sessions.ownerUserId,
			})
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		const [session] = await (config.dialect === "postgres" ? read.for("update") : read);
		if (!session) throw new Error("A resume settled for a session whose row is gone.");

		const {
			endedByEvent: _ended,
			permissionWait: _wait,
			...kept
		} = (session.metadata ?? {}) as Record<string, unknown>;
		const wait = waitAfterResume({ permissionWait: (session.metadata as any)?.permissionWait });
		const metadata = {
			...kept,
			managedResumeAt: timestamp,
			...(wait ? { permissionWait: wait } : {}),
		};
		const updated = await tx
			.update(sessions)
			.set({
				endedAt: null,
				status: "idle",
				isWorking: false,
				currentTurnStartedAt: null,
				lastActivityAt: timestamp,
				metadata,
				...(session.semanticStatus === "waiting" ? { semanticStatus: null } : {}),
			})
			.where(eq(sessions.sessionId, sessionId))
			.returning({ id: sessions.id });
		if (updated.length === 0) throw new Error("A resume settled for a session whose row is gone.");

		await assignOwnerIfAsked(tx, action, sessionId, session.ownerUserId ?? null);

		const kind = resumeKindOf(action);
		await tx.insert(events).values({
			sessionId,
			eventType: SESSION_RESUMED_EVENT_TYPE,
			category: "system_event",
			source: "managed_control",
			content: SESSION_RESUMED_CONTENT[kind],
			isNoise: false,
			rawPayload: { resume_kind: kind },
			createdAt: timestamp,
		});
		await tx
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
			.where(
				and(
					eq(managedSessions.sessionId, sessionId),
					eq(managedSessions.activeControlActionId, action.id),
				),
			);
		await deps.afterWrites?.(tx);
		return { settled: true, sessionId, outcome: "succeeded" };
	});
	await announceAfterSettle(handle, outcome);
	return outcome;
}

/** D6: an unowned session taken over by an admin gets its intended owner only now that the takeover has worked. */
async function assignOwnerIfAsked(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	action: ResumeActionRef,
	sessionId: string,
	currentOwner: string | null,
): Promise<void> {
	const metadata = (action.metadata ?? {}) as { assignOwner?: unknown; boundByUserId?: unknown };
	if (metadata.assignOwner !== true || currentOwner !== null || !action.launchRequestId) return;
	const [launch] = await tx
		.select({ requestedByUserId: launchRequests.requestedByUserId })
		.from(launchRequests)
		.where(eq(launchRequests.id, action.launchRequestId))
		.limit(1);
	const intended = launch?.requestedByUserId ?? null;
	if (intended === null) return;
	try {
		await assignTakeoverOwner(tx, sessionId, intended);
	} catch (error) {
		if (!(error instanceof OwnerDisabledError || error instanceof OwnerNotFoundError)) throw error;
		console.log(
			JSON.stringify({
				kind: "takeover_owner_unassignable",
				level: "warn",
				sessionId,
				launchRequestId: action.launchRequestId,
				boundByUserId: typeof metadata.boundByUserId === "string" ? metadata.boundByUserId : null,
			}),
		);
	}
}

/** A lapsed lock on a resume: if the host's state report landed (managed, this launch) it worked; otherwise it didn't. */
async function settleExpiredResume(
	handle: unknown,
	managed: typeof managedSessions.$inferSelect,
	action: typeof controlActions.$inferSelect,
): Promise<ResumeSettle> {
	if (managed.managedState === "managed" && managed.launchRequestId === action.launchRequestId) {
		return completeResumeAction(handle, action);
	}
	return failResumeAction(
		handle,
		action,
		resumeFailureMessage("timeout", managed.hostName ?? "The host", resumeKindOf(action)),
	);
}

export const RESUME_SWEEP_BATCH = 100;

/**
 * Settles the resume actions whose lock has run out, oldest first, at most `RESUME_SWEEP_BATCH` a pass. The
 * lazy expiry only runs from the owning host's own polls and the enqueue paths, so an offline, removed or
 * revoked host would otherwise hold a session in `pending` for ever. One failing action doesn't stop the rest.
 */
export async function sweepExpiredResumeActions(nowMs: number = Date.now()): Promise<number> {
	const candidates: Array<{ sessionId: string; lockExpiresAt: string | null }> = await getDb()
		.select({
			sessionId: managedSessions.sessionId,
			lockExpiresAt: managedSessions.controlLockExpiresAt,
		})
		.from(controlActions)
		.innerJoin(managedSessions, eq(managedSessions.activeControlActionId, controlActions.id))
		.where(
			and(
				eq(controlActions.actionType, "resume"),
				inArray(controlActions.status, ["queued", "running"]),
			),
		)
		.orderBy(asc(controlActions.createdAt))
		.limit(RESUME_SWEEP_BATCH * 5);
	const lapsed = candidates
		.filter((row) => row.lockExpiresAt !== null && new Date(row.lockExpiresAt).getTime() <= nowMs)
		.slice(0, RESUME_SWEEP_BATCH);
	let settled = 0;
	for (const row of lapsed) {
		try {
			await expireStaleControlLock(getDb(), row.sessionId, () => nowMs);
			settled += 1;
		} catch (error) {
			console.error(
				JSON.stringify({
					kind: "resume_sweep_failed",
					level: "error",
					sessionId: row.sessionId,
					error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
				}),
			);
		}
	}
	return settled;
}

/** A host that lost `resumes_sessions` (rolled back, replaced) is told so at claim time, not left to the lock. */
async function refuseResumeForOldHost(
	action: typeof controlActions.$inferSelect,
	supervisorId: string,
): Promise<boolean> {
	const host = await getSupervisor(supervisorId);
	if ((host?.capabilities.features ?? []).includes(RESUMES_SESSIONS)) return false;
	await failResumeAction(
		null,
		action,
		resumeFailureMessage(
			"host_upgrade_required",
			host?.hostName ?? "The host",
			resumeKindOf(action),
		),
	);
	return true;
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

export function mapControlAction(row: typeof controlActions.$inferSelect): ControlAction {
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

/**
 * The host that owns the session is not connected, so nothing queued now would
 * be taken within the 90 s the control lock lasts. The host may come back.
 */
export class HostOfflineError extends Error {
	readonly code = "host_offline";
	constructor() {
		super("The host running this session is offline, so it can't be controlled right now.");
		this.name = "HostOfflineError";
	}
}
/** The host that owns the session was removed (or never existed), so it will not come back. */
export class HostGoneError extends Error {
	readonly code = "host_gone";
	constructor() {
		super("The host that ran this session was removed from AgentPulse.");
		this.name = "HostGoneError";
	}
}

/**
 * The host's supervisor predates `codex_follow_up_prompts`, so it would send a Codex prompt down the
 * Claude path. Nothing is queued: the host has to be upgraded first.
 */
export class HostUpgradeRequiredError extends Error {
	readonly code = "host_upgrade_required";
	constructor(message: string = HOST_UPGRADE_REQUIRED_MESSAGE) {
		super(message);
		this.name = "HostUpgradeRequiredError";
	}
}

/** What a person is told when a Codex session's process is gone (its host restarted): nothing can be sent to it. */
export const MANAGED_STATE_NOT_CONTINUABLE_MESSAGE =
	"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.";

/**
 * A Codex session whose managed state can no longer take a prompt: registration moves the host's Codex
 * sessions to `degraded` because their app-servers died with the previous supervisor process.
 */
export class ManagedStateNotContinuableError extends Error {
	readonly code = "managed_state_not_continuable";
	constructor() {
		super(MANAGED_STATE_NOT_CONTINUABLE_MESSAGE);
		this.name = "ManagedStateNotContinuableError";
	}
}

/** A Stop on a session started in a terminal: nothing here can stop it, so nothing is queued (AGEN-110). */
export class StopNotSupportedError extends Error {
	readonly code = "stop_not_supported";
	constructor() {
		super(STOP_NOT_SUPPORTED_MESSAGE);
		this.name = "StopNotSupportedError";
	}
}

/** The session has ended and its launch has finished: a stop has nothing to act on (AGEN-110). */
export class NothingToStopError extends Error {
	readonly code = "nothing_to_stop";
	constructor() {
		super("This session has already ended, so there is nothing to stop.");
		this.name = "NothingToStopError";
	}
}

export type EnqueueRefusal =
	| "stop_not_supported"
	| "nothing_to_stop"
	| "not_managed"
	| "session_missing"
	| "launch_missing"
	| "launch_mismatch"
	| "control_busy"
	| "host_offline"
	| "host_gone"
	| "host_upgrade_required"
	| "managed_state";

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
		case "host_offline":
			return new HostOfflineError();
		case "host_gone":
			return new HostGoneError();
		case "host_upgrade_required":
			return new HostUpgradeRequiredError();
		case "managed_state":
			return new ManagedStateNotContinuableError();
		case "nothing_to_stop":
			return new NothingToStopError();
		case "stop_not_supported":
			return new StopNotSupportedError();
	}
}

/**
 * Does this supervisor advertise `feature` (a Codex follow-up prompt, a Claude stop)? Capabilities are the
 * host's own report, so they're read through the same cleaner as everywhere else: a missing, malformed or
 * misspelt list means no.
 */
async function supervisorHasFeature(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	supervisorId: string,
	feature: string,
): Promise<boolean> {
	const [row] = await db
		.select({ capabilities: supervisors.capabilities })
		.from(supervisors)
		.where(eq(supervisors.id, supervisorId))
		.limit(1);
	if (!row) return false;
	return (withCapabilityDefaults(row.capabilities).features ?? []).includes(feature);
}

/**
 * Does the host that owns the session advertise `feature`? Read on the caller's transaction (the
 * ordinary handle inside `withAdminLock` is forbidden); a session with no owner of record has no host that does.
 */
async function hostHasFeature(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
	feature: string,
): Promise<boolean> {
	const owner = await resolveSessionOwner(tx, sessionId);
	return owner !== null && (await supervisorHasFeature(tx, owner, feature));
}

/** Whether the host that owns the session takes Codex prompts. */
export function hostTakesCodexPrompts(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
): Promise<boolean> {
	return hostHasFeature(tx, sessionId, CODEX_FOLLOW_UP_PROMPTS);
}

/**
 * Stop and prompt are taken by the owning host within seconds or not at all, so
 * a host that isn't live is refused here instead of failing 90 s later. Read on
 * the caller's transaction. A lease that runs out between this read and the
 * insert is accepted: the action then fails by the existing lock expiry.
 */
async function hostRefusal(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
	clock: Clock = Date.now,
): Promise<Extract<EnqueueRefusal, "host_offline" | "host_gone"> | null> {
	const host = (await getSessionOwnerHostStates([sessionId], clock(), tx)).get(sessionId);
	if (!host || host.state === "live") return null;
	return host.state === "offline" ? "host_offline" : "host_gone";
}

/**
 * Would a prompt to this managed session be refused because its host can't take Codex prompts? The
 * advisory form of the enqueue-time check, for deliverability: false for a Claude launch (no host read).
 */
export async function promptNeedsHostUpgrade(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
): Promise<boolean> {
	const [managed] = await db
		.select({ launchRequestId: managedSessions.launchRequestId })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) return false;
	const launch = await resolveManagedLaunch(db, sessionId, managed.launchRequestId);
	if (launch?.agentType !== "codex_cli") return false;
	return !(await hostTakesCodexPrompts(db, sessionId));
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
	clock: Clock = Date.now,
): Promise<boolean> {
	const taken = await tx
		.update(managedSessions)
		.set({
			activeControlActionId: controlActionId,
			controlLockExpiresAt: lockExpiryIso(clock),
			updatedAt: timestamp,
		})
		.where(
			and(eq(managedSessions.sessionId, sessionId), isNull(managedSessions.activeControlActionId)),
		)
		.returning({ sessionId: managedSessions.sessionId });
	return taken.length > 0;
}

/**
 * What the host must stop for a session, from its launch (never the session row, which an ingest key can
 * create with an agent type of its choosing): `codex`, `claude_stream` (a carrier that took over an
 * observed session), `claude_headless` or `claude_terminal`. Null when the launch is unknown or the mode
 * isn't one a stop is defined for; the host then reads the absence as Codex, as it always did.
 */
export function stopRuntimeOf(
	launch: Pick<
		typeof launchRequests.$inferSelect,
		"agentType" | "requestedLaunchMode" | "metadata"
	>,
): StopRuntime | null {
	if (launch.agentType === "codex_cli") return STOP_RUNTIMES.codex;
	if (launch.agentType !== "claude_code") return null;
	if ((launch.metadata as Record<string, unknown> | null)?.boundObservedSession === true) {
		return STOP_RUNTIMES.claudeStream;
	}
	if (launch.requestedLaunchMode === "headless") return STOP_RUNTIMES.claudeHeadless;
	if (launch.requestedLaunchMode === "interactive_terminal") return STOP_RUNTIMES.claudeTerminal;
	return null;
}

/**
 * Queue a stop on `tx`: every read and write goes through it, no expected
 * outcome throws, and the lock is taken (conditionally) before the action row
 * is written.
 */
export async function enqueueStopInTx(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	input: { sessionId: string; actor: Actor; controlActionId: string; now?: Clock },
): Promise<
	| { ok: true; action: ControlAction; fencedApprovals: ClosedApproval[] }
	| { ok: false; reason: EnqueueRefusal }
> {
	const { sessionId, actor, controlActionId } = input;
	const clock = input.now ?? Date.now;
	await expireStaleControlLock(tx, sessionId, clock);
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
	const stopRuntime = stopLaunch ? stopRuntimeOf(stopLaunch) : null;
	const claudeStop = isClaudeStopRuntime(stopRuntime);
	// Refused before anything else is judged or written: no host read, no lock, no row.
	if (stopRuntime === STOP_RUNTIMES.claudeTerminal) {
		return { ok: false, reason: "stop_not_supported" };
	}
	// Both rows are already in hand. Only a stop whose managed state AND launch have ended is refused: a
	// lost final report leaves one of them live, and a Stop is how that session gets repaired (it reads
	// `stopped` and the launch `cancelled`). Codex is left as it was.
	if (
		claudeStop &&
		stopLaunch &&
		TERMINAL_MANAGED_STATES.has(managed.managedState) &&
		FINISHED_LAUNCH_STATUSES.has(stopLaunch.status)
	) {
		return { ok: false, reason: "nothing_to_stop" };
	}
	const stopHostRefusal = await hostRefusal(tx, sessionId, clock);
	if (stopHostRefusal) return { ok: false, reason: stopHostRefusal };
	// Only a Claude launch asks the host anything: a Codex stop costs no extra statement.
	if (claudeStop && !(await hostHasFeature(tx, sessionId, CLAUDE_STOP))) {
		return { ok: false, reason: "host_upgrade_required" };
	}

	const timestamp = nowIso(clock);
	if (!(await takeControlLock(tx, sessionId, controlActionId, timestamp, clock))) {
		return { ok: false, reason: "control_busy" };
	}
	// The Stop fence for Codex approvals: no accept is issued after this commits. It runs
	// only once the lock is ours (a Stop refused control_busy fences nothing) and on this
	// transaction, so the fence and the lock commit or roll back together.
	const fence = await fenceApprovalsForStop(tx, sessionId, controlActionId, clock());
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
			metadata: stopRuntime === null ? {} : { runtime: stopRuntime },
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.returning();
	return { ok: true, action: mapControlAction(action), fencedApprovals: fence.closed };
}

/**
 * Queues a stop. With `tx` it runs inside the caller's transaction; without one it opens its own.
 * The timeline and wait side effects of any approvals the Stop closed run after the commit this
 * function owns; a caller passing its own `tx` commits it itself, and the sweep covers its rows.
 */
export async function queueStopAction(
	sessionId: string,
	actor: Actor,
	tx?: DbHandle,
	deps: { now?: Clock } = {},
) {
	const input = { sessionId, actor, controlActionId: crypto.randomUUID(), now: deps.now };
	const result = tx
		? await enqueueStopInTx(tx, input)
		: await withAdminLock((own) => enqueueStopInTx(own, input));
	if (!result.ok) {
		// The only upgrade a stop can need is the Claude one.
		throw result.reason === "host_upgrade_required"
			? new HostUpgradeRequiredError(CLAUDE_STOP_UPGRADE_MESSAGE)
			: refusalToError(result.reason);
	}
	if (!tx) await runApprovalClosedEffects(result.fencedApprovals, deps);
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
	// The action is routed by the launch's agent type, which only a launch request sets. A session row can be
	// created by anyone with an ingest key, under a launch's id, with an agent type of their choosing; one that
	// disagrees with its launch is refused, so it can't send a Codex launch's prompt down the Claude path.
	if (session.agentType !== launch.agentType) return { ok: false, reason: "launch_mismatch" };
	const promptHostRefusal = await hostRefusal(tx, sessionId);
	if (promptHostRefusal) return { ok: false, reason: promptHostRefusal };
	const isCodex = launch.agentType === "codex_cli";
	// Only a Codex launch asks the host anything: Claude prompts cost no extra statement.
	if (isCodex && !(await hostTakesCodexPrompts(tx, sessionId))) {
		return { ok: false, reason: "host_upgrade_required" };
	}
	// A row still `pending` with an action holding its lock is being taken over or resumed: it can't take a
	// prompt yet, and "not continuable" would send the person off to start again. Narrow on purpose: a
	// pending row with no active action keeps the answer below.
	if (isCodex && managed.managedState === "pending" && managed.activeControlActionId) {
		return { ok: false, reason: "control_busy" };
	}
	// A Codex session's process dies with its host's supervisor, and registration then marks it degraded: a
	// prompt queued for it would only be refused by the host after the person was told it was sent.
	if (isCodex && !CONTINUABLE_MANAGED_STATES.has(managed.managedState as ManagedState)) {
		return { ok: false, reason: "managed_state" };
	}
	// Judged after the refusals above, so a held lock doesn't hide why the session can't take a prompt;
	// the conditional lock below still decides a race.
	if (managed.activeControlActionId) return { ok: false, reason: "control_busy" };

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
				agentType: launch.agentType,
				// The launch's directory (judged against the host's trusted roots when it was
				// requested), never the agent-reported session.cwd, which the agent can change.
				cwd: launch.cwd,
				managedState: managed.managedState,
				launchMode: launch.requestedLaunchMode,
				// A Claude resume starts a new agent process, so it carries the launch's model, recorded
				// privileges (null = the agent's default) and env for the supervisor to re-apply. A Codex
				// follow-up starts a turn on a thread whose settings were set and verified at launch and are
				// sticky: it sends nothing that could widen them, so none of this is ever in the row.
				...(isCodex
					? {}
					: {
							model: launch.model ?? null,
							approvalPolicy: launch.approvalPolicy ?? null,
							sandboxMode: launch.sandboxMode ?? null,
							env: launch.env ?? {},
						}),
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
	// A taken-over session's launch row is a record of the takeover, not a recipe: its host, directory and
	// privileges describe a thread that already existed. Refused before anything is cloned.
	if ((original.metadata as Record<string, unknown> | null)?.boundObservedSession === true) {
		throw new BindRefusal("retry_not_available");
	}
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
	// A retry to an offline host still works: the clone stays validated until that host
	// claims it. One aimed at a host that was removed never will, so nothing is cloned.
	const retryHostId = original.requestedSupervisorId ?? original.resolvedSupervisorId;
	const retryHost = retryHostId ? await getSupervisor(retryHostId) : null;
	if (original.requestedSupervisorId && (!retryHost || retryHost.enrollmentState === "revoked")) {
		throw new HostGoneError();
	}
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

const LAUNCH_MISMATCH_CLAIM_MESSAGE =
	"This session's records don't match how it was launched, so nothing was sent.";

/**
 * Why a queued prompt must not be handed to this supervisor, or null. An action queued by an older
 * server, or before the host re-registered without the feature, never passed the enqueue-time check, so
 * the claim re-judges it: by the launch's agent type, else (no launch row) the action's own record.
 */
async function claimRefusalForPrompt(
	action: typeof controlActions.$inferSelect,
	launchAgentType: string | null,
	supervisorId: string,
): Promise<string | null> {
	const recorded = (action.metadata as Record<string, unknown> | null)?.agentType;
	const recordedType = typeof recorded === "string" ? recorded : null;
	if (launchAgentType !== null && recordedType !== null && recordedType !== launchAgentType) {
		return LAUNCH_MISMATCH_CLAIM_MESSAGE;
	}
	const effective = launchAgentType ?? recordedType;
	// With no launch row there is nothing to check a record against: only an explicit Claude record passes.
	if (launchAgentType === null && effective !== "claude_code" && effective !== "codex_cli") {
		console.warn(
			`[control-actions] prompt ${action.id} has no launch row and no usable agent type; failing it`,
		);
		return LAUNCH_MISMATCH_CLAIM_MESSAGE;
	}
	if (effective !== "codex_cli") return null;
	return (await supervisorHasFeature(getDb(), supervisorId, CODEX_FOLLOW_UP_PROMPTS))
		? null
		: HOST_UPGRADE_REQUIRED_MESSAGE;
}

/**
 * Why a queued stop must not be handed to this supervisor, or null: a Claude stop for a host that no longer
 * advertises `claude_stop` (rolled back, or replaced by an older build since it was queued). Judged from the
 * action's own runtime, which the server wrote at enqueue; a Codex stop costs nothing extra.
 */
async function claimRefusalForStop(
	action: typeof controlActions.$inferSelect,
	supervisorId: string,
): Promise<string | null> {
	const runtime = (action.metadata as Record<string, unknown> | null)?.runtime;
	if (typeof runtime !== "string" || !isClaudeStopRuntime(runtime)) return null;
	return (await supervisorHasFeature(getDb(), supervisorId, CLAUDE_STOP))
		? null
		: CLAUDE_STOP_UPGRADE_MESSAGE;
}

/** Fail an unclaimed action (an AI prompt past its TTL, or a prompt or stop this host must not take), release its lock and close its audit row. */
async function failUnclaimedAction(action: typeof controlActions.$inferSelect, error: string) {
	const timestamp = nowIso();
	await getDb()
		.update(controlActions)
		.set({
			status: "failed",
			error,
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
			.select({ action: controlActions, launchAgentType: launchRequests.agentType })
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
		const launchAgentType = sessionRow[0]?.launchAgentType ?? null;
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
			await failUnclaimedAction(candidate, "Expired before a supervisor claimed it.");
			continue;
		}
		if (candidate.actionType === "prompt" && candidate.sessionId) {
			const refusal = await claimRefusalForPrompt(candidate, launchAgentType, supervisorId);
			if (refusal) {
				await failUnclaimedAction(candidate, refusal);
				continue;
			}
		}

		if (candidate.actionType === "stop") {
			const refusal = await claimRefusalForStop(candidate, supervisorId);
			if (refusal) {
				await failUnclaimedAction(candidate, refusal);
				continue;
			}
		}

		if (candidate.actionType === "resume" && candidate.sessionId) {
			if (await refuseResumeForOldHost(candidate, supervisorId)) continue;
		}

		const timestamp = nowIso();
		const [updated] = await getDb()
			.update(controlActions)
			.set({
				status: "running",
				claimedBySupervisorId: supervisorId,
				updatedAt: timestamp,
			})
			// Only a still-queued action: another claim may have taken it since it was read.
			.where(and(eq(controlActions.id, candidate.id), eq(controlActions.status, "queued")))
			.returning();
		if (!updated) continue;
		return mapControlAction(updated);
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

	// A resume ends through the one settle, which also moves the rows (D10).
	if (current.actionType === "resume" && input.status !== "running") {
		if (input.status === "failed") {
			await failResumeAction(
				null,
				current,
				input.error ?? resumeFailureMessage("rejected", "The host", resumeKindOf(current)),
			);
		} else {
			// The host says it worked. If the row never became `managed`, it didn't: that's a failure.
			const [managed] = await getDb()
				.select({
					managedState: managedSessions.managedState,
					launchRequestId: managedSessions.launchRequestId,
				})
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, current.sessionId ?? ""))
				.limit(1);
			if (
				managed &&
				managed.launchRequestId === current.launchRequestId &&
				managed.managedState !== "managed"
			) {
				await failResumeAction(
					null,
					current,
					resumeFailureMessage("rejected", "The host", resumeKindOf(current)),
				);
			} else {
				await completeResumeAction(null, current);
			}
		}
		const [fresh] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, input.actionId))
			.limit(1);
		return fresh ? mapControlAction(fresh) : null;
	}

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
