import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { isWithinWindow } from "../../shared/time-window.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedState,
	Session,
} from "../../shared/types.js";
import { getDb } from "../db/client.js";
import {
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	users,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { markAuditExpiredUnclaimed } from "./ai/dispatch-audit-service.js";
import { closeApprovalsForSession } from "./codex-approvals.js";
import {
	type NormalizedEvent,
	isApprovalResolvedEventName,
	isServerOnlyEventName,
} from "./event-normalizer.js";
import {
	type ManagedInsertDeps,
	type ManagedInsertResult,
	insertManagedEvents,
	insertNormalizedEvents,
} from "./event-processor.js";
import { cleanMachineName } from "./machine-name.js";
import { HOST_RESTARTED_SYNC_ERROR } from "./managed-sync-errors.js";
import { generateSessionName } from "./name-generator.js";
import { ownerForNewSession } from "./session-attribution.js";
import { mapSessionDto } from "./session-dto.js";
import {
	assertSupervisorCanWriteSession,
	ownerLaunchJoin,
	sessionOwnedBy,
} from "./session-ownership.js";

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
	const [row] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	return row ? mapManagedSession(row) : null;
}

/**
 * A state report that says the managed session has ended: `status` completed or
 * failed, or a managed state of stopped, completed or failed. Mirrors the
 * supervisor gate's isTerminalReport. `degraded` is not terminal (a rename that
 * failed to sync leaves it on a live runtime), so it never closes an approval.
 */
export function isTerminalStateReport(input: ManagedSessionStateInput): boolean {
	return (
		input.status === "completed" ||
		input.status === "failed" ||
		input.managedState === "stopped" ||
		input.managedState === "completed" ||
		input.managedState === "failed"
	);
}

/**
 * `permissionWait` is the server's own record of what a session is blocked on, written
 * from hook events and approval rows. A supervisor's metadata must not be able to set
 * or clear it.
 */
function withoutServerOwnedMetadata(
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
	if (!metadata || !("permissionWait" in metadata)) return metadata;
	const { permissionWait: _serverOwned, ...rest } = metadata;
	return rest;
}

export async function upsertManagedSessionState(
	supervisorId: string,
	input: ManagedSessionStateInput,
	options: {
		/**
		 * The report is a replay from the supervisor's outbox, or a late one. It can be
		 * older than the approval rows, so it closes none.
		 */
		replay?: boolean;
	} = {},
): Promise<{ session: Session; managedSession: ManagedSession }> {
	await assertSupervisorCanWriteSession(supervisorId, input.sessionId, {
		launchRequestId: input.launchRequestId,
	});
	const supervisorMetadata = withoutServerOwnedMetadata(input.metadata);
	const timestamp = nowIso();
	const [existingManaged] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);
	const [existingSession] = await getDb()
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

	// A Codex runtime reporting idle means its turn is over (completed, failed to start, or the
	// runtime closed), whatever event did or didn't arrive. Folded into the update this function
	// already makes, so it costs no statement. A repeat after a Completed event moves nothing:
	// the completion is stamped only if the session was still working.
	if (input.status === "idle" && existingSession?.agentType === "codex_cli") {
		sessionUpdates.isWorking = false;
		sessionUpdates.currentTurnStartedAt = null;
		if (existingSession.isWorking) sessionUpdates.lastAgentTurnCompletedAt = timestamp;
	}

	if (!existingSession) {
		// The supervisor-report creation path. Owner comes from a
		// correlated launch's requester when this report already names one
		// (input.launchRequestId), else from the supervisor's own owner.
		// ingestKeyId always stays null here — only the hook path ever sets
		// it. onConflictDoNothing because the hook path can race to create
		// the same session id first; currentSession is re-read unconditionally
		// right below regardless of which side's insert actually won.
		let launchRequesterUserId: string | null = null;
		if (input.launchRequestId) {
			const [launch] = await getDb()
				.select({ requestedByUserId: launchRequests.requestedByUserId })
				.from(launchRequests)
				.where(eq(launchRequests.id, input.launchRequestId))
				.limit(1);
			launchRequesterUserId = launch?.requestedByUserId ?? null;
		}
		// A host kept when its owner was disabled still works, but its owner is
		// gone: the join leaves a disabled owner out, so the session is unowned.
		const [supervisorRow] = await getDb()
			.select({ ownerUserId: users.id })
			.from(supervisors)
			.leftJoin(users, and(eq(users.id, supervisors.ownerUserId), isNull(users.disabledAt)))
			.where(eq(supervisors.id, supervisorId))
			.limit(1);
		const owner = ownerForNewSession({
			launchRequesterUserId,
			supervisorOwnerUserId: supervisorRow?.ownerUserId ?? null,
		});

		await getDb()
			.insert(sessions)
			.values({
				sessionId: input.sessionId,
				displayName: input.desiredThreadTitle || generateSessionName(),
				agentType: input.agentType ?? "codex_cli",
				status: (input.status ?? "active") as string,
				cwd: input.cwd ?? null,
				model: input.model ?? null,
				startedAt: timestamp,
				lastActivityAt: timestamp,
				metadata: supervisorMetadata ?? {},
				ownerUserId: owner.ownerUserId,
				ingestKeyId: owner.ingestKeyId,
			})
			.onConflictDoNothing({ target: sessions.sessionId });
	} else {
		await withTransaction(async (tx) => {
			const updates: Record<string, unknown> = { ...sessionUpdates };
			if (supervisorMetadata) {
				// Late read-modify-write inside the transaction: re-read metadata
				// immediately before writing so a concurrent writer's keys (e.g.
				// applyPermissionWaitTransition's permissionWait) aren't clobbered
				// by the early `existingSession` snapshot read at the top of this
				// function. Same pattern and honesty level as Decision 10.
				const [fresh] = await tx
					.select({ metadata: sessions.metadata })
					.from(sessions)
					.where(eq(sessions.sessionId, input.sessionId))
					.limit(1);
				updates.metadata = {
					...(fresh?.metadata ?? {}),
					...supervisorMetadata,
				};
			}
			await tx.update(sessions).set(updates).where(eq(sessions.sessionId, input.sessionId));
		});
	}

	const [currentSession] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, input.sessionId))
		.limit(1);

	const desiredTitle = input.desiredThreadTitle ?? currentSession?.displayName ?? null;
	const [supervisor] = await getDb()
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
	// A replayed report is older than the restart that degraded this row: its process is gone, so
	// it can't make the row managed again. A live report still wins, which is how a later
	// rebind will bring the session back.
	const heldDegraded =
		options.replay === true &&
		existingManaged?.managedState === "degraded" &&
		existingManaged.providerSyncError === HOST_RESTARTED_SYNC_ERROR;
	const providerSyncState =
		(heldDegraded ? undefined : input.providerSyncState) ??
		existingManaged?.providerSyncState ??
		"pending";
	const providerSyncError =
		(heldDegraded ? undefined : input.providerSyncError) ??
		existingManaged?.providerSyncError ??
		null;
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
		(heldDegraded ? undefined : input.managedState) ??
		(existingManaged?.managedState as ManagedState | undefined) ??
		"managed";

	await getDb()
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
			hostName: existingManaged?.hostName ?? cleanMachineName(supervisor?.hostName),
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
				hostName: existingManaged?.hostName ?? cleanMachineName(supervisor?.hostName),
				hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
				updatedAt: timestamp,
			},
		});

	const [managedRow] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	// A live report that the session ended closes its open Codex approvals: nothing can
	// still be waiting for an answer. Not a replayed report, which may predate them.
	if (options.replay !== true && isTerminalStateReport(input)) {
		await closeApprovalsForSession(input.sessionId);
	}

	// F85 (ian mid-build): map here, once, so the REST response (this
	// function's `session`, returned as-is by supervisors.ts's
	// `c.json(result)`) and the WS broadcast (notifySessionUpdated, called
	// with this same object) can never drift apart on nameSource/nativeName.
	// mapSessionDto is pure/idempotent over (displayName, metadata), so the
	// notifier's own internal re-map is a harmless no-op recomputation, not
	// a second source of truth.
	const mappedSession = mapSessionDto(currentSession, {
		managedSession: managedRow ? mapManagedSession(managedRow) : null,
	});

	return {
		// Drizzle infers `agentType`/`status` etc. as plain `string`; `Session`
		// narrows them to literal unions. The producers only ever stamp valid
		// members, so this cast is the same DB-row-to-typed-view boundary
		// used elsewhere in this file (mapManagedSession above) — unrelated
		// to nameSource/nativeName, which mapSessionDto already filled in.
		session: mappedSession as unknown as Session,
		managedSession: mapManagedSession(managedRow!),
	};
}

/** A supervisor tried to write an event only the watcher may write. */
export class ReservedEventTypeError extends Error {
	constructor() {
		super("A supervisor may not write the watcher's own events.");
		this.name = "ReservedEventTypeError";
	}
}

function isReservedEvent(event: ManagedSessionEventInput): boolean {
	return (
		(typeof event.category === "string" && event.category.startsWith("ai_")) ||
		isServerOnlyEventName(event.eventType) ||
		isApprovalResolvedEventName(event.providerEventType)
	);
}

/** How far back, and ahead, a supervisor-stamped occurrence time is believed (display only). */
export const OCCURRED_AT_PAST_MS = 25 * 60 * 60 * 1000;
export const OCCURRED_AT_FUTURE_MS = 5 * 60 * 1000;

const occurredAtRejectionLogged = new Set<string>();

/** Test seam: forget which supervisors already had a rejected occurrence time logged. */
export function _resetOccurredAtRejectionLogForTest(): void {
	occurredAtRejectionLogged.clear();
}

/**
 * The occurrence time to store: the sender's value as normalized ISO when it
 * parses and lies inside the accepted window, else null. A value outside the
 * window (clock skew, a very old replay) is never an error; it is logged once
 * per supervisor per boot, without the value.
 */
function acceptedOccurredAt(supervisorId: string, value: unknown, nowMs: number): string | null {
	if (value === undefined || value === null) return null;
	if (isWithinWindow(value, nowMs, OCCURRED_AT_PAST_MS, OCCURRED_AT_FUTURE_MS)) {
		return new Date(parseStoredTimestamp(value as string) as number).toISOString();
	}
	if (!occurredAtRejectionLogged.has(supervisorId)) {
		occurredAtRejectionLogged.add(supervisorId);
		console.warn(JSON.stringify({ kind: "occurred_at_rejected", supervisorId }));
	}
	return null;
}

async function prepareManagedEvents(
	supervisorId: string,
	sessionId: string,
	events: ManagedSessionEventInput[],
): Promise<NormalizedEvent[]> {
	await assertSupervisorCanWriteSession(supervisorId, sessionId);
	// The whole batch is refused: one forged event poisons the rest.
	if (events.some(isReservedEvent)) throw new ReservedEventTypeError();
	const nowMs = Date.now();
	return events.map((event) => ({
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
		occurredAt: acceptedOccurredAt(supervisorId, event.occurredAt, nowMs),
	}));
}

export async function appendManagedSessionEvents(
	supervisorId: string,
	sessionId: string,
	events: ManagedSessionEventInput[],
	options: { late?: boolean } = {},
) {
	const prepared = await prepareManagedEvents(supervisorId, sessionId, events);
	const stored = await insertNormalizedEvents(sessionId, prepared);
	// No delivery id means no receipt transaction to ride: the update follows the insert.
	await applyManagedTurnBoundaries(getDb(), sessionId, prepared, { late: options.late === true });
	return stored;
}

/**
 * The same append for a delivery that carries a delivery id: the receipt and the
 * events are written in one transaction, and a delivery already received stores
 * nothing (`replay: true`). `deps` is the rollback / receipt seam for tests.
 */
export async function appendManagedSessionDelivery(
	supervisorId: string,
	sessionId: string,
	events: ManagedSessionEventInput[],
	delivery: { deliveryId: string; bodyDigest: string },
	deps?: Partial<ManagedInsertDeps>,
	options: { late?: boolean } = {},
): Promise<ManagedInsertResult> {
	const prepared = await prepareManagedEvents(supervisorId, sessionId, events);
	return insertManagedEvents(
		sessionId,
		prepared,
		{ senderId: supervisorId, ...delivery },
		{
			// Inside the receipt transaction, on the batch as sent: a row the window dropped still counts.
			afterRows: (tx) =>
				applyManagedTurnBoundaries(tx, sessionId, prepared, { late: options.late === true }),
			...deps,
		},
	);
}

/** The slice of an event the turn rules read; a NormalizedEvent satisfies it. */
export interface TurnBoundaryEvent {
	eventType: string;
	rawPayload?: Record<string, unknown> | null;
}

type TurnChange = "start" | "launch_start" | "end" | "stopped";

/** What one event does to a managed Codex session's turn, or null. The marker is what makes it a Codex runtime's. */
function turnChangeOf(event: TurnBoundaryEvent, late: boolean): TurnChange | null {
	const marked = event.rawPayload?.codexRuntime === true;
	switch (event.eventType) {
		case "HeadlessPromptSubmitted":
			return marked && !late ? "start" : null;
		case "ManagedSessionStart":
			return marked && !late ? "launch_start" : null;
		case "HeadlessPromptCompleted":
		case "HeadlessPromptFailed":
			return marked ? "end" : null;
		case "ManagedSessionStopped":
			return "stopped";
		default:
			return null;
	}
}

/**
 * A managed Codex turn's working state, from the events a supervisor reports (AGEN-91 D5). Codex's
 * own hooks post under the thread id, not this session's id, so nothing else flips these columns.
 * The last relevant event in the batch wins. A late report (an outbox replay) can end a turn but
 * never start one. `db` is the receipt transaction's `tx` when there is one.
 *
 * Statements: none for a batch with no relevant event (every Claude event lacks the marker, so no
 * agent-type read is needed to decide that); one guarded UPDATE otherwise. The guard on
 * `agent_type` keeps a marker on another agent's row from changing anything.
 */
export async function applyManagedTurnBoundaries(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
	incoming: readonly TurnBoundaryEvent[],
	options: { late: boolean },
): Promise<void> {
	let last: TurnChange | null = null;
	for (const event of incoming) last = turnChangeOf(event, options.late) ?? last;
	if (last === null) return;

	const now = new Date().toISOString();
	const updates: Record<string, unknown> =
		last === "stopped"
			? { isWorking: false, currentTurnStartedAt: null }
			: last === "end"
				? {
						isWorking: false,
						currentTurnStartedAt: null,
						lastAgentTurnCompletedAt: now,
						lastActivityAt: now,
					}
				: {
						isWorking: true,
						currentTurnStartedAt: now,
						lastActivityAt: now,
						status: "active",
						endedAt: null,
						// A sent prompt acknowledges whatever came before it; the launch turn has nothing before it.
						...(last === "start" ? { lastUserAcknowledgedAt: now } : {}),
					};
	await db
		.update(sessions)
		.set(updates)
		.where(and(eq(sessions.sessionId, sessionId), eq(sessions.agentType, "codex_cli")));
}

const DEGRADE_CHUNK = 500;
const TERMINAL_MANAGED_STATES: readonly string[] = ["stopped", "completed", "failed"];
export const HOST_RESTARTED_PROMPT_ERROR =
	"The host's supervisor restarted before this prompt was confirmed.";

function inChunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += DEGRADE_CHUNK) out.push(items.slice(i, i + DEGRADE_CHUNK));
	return out;
}

/**
 * A supervisor registered again, so the process (and every app-server) it ran before is gone
 * (AGEN-91 D8). In one transaction, for the sessions that host owns of record:
 *  - every nonterminal Codex session becomes `degraded` with HOST_RESTARTED_SYNC_ERROR, which a
 *    replayed report can't undo (a rename-failure row is stamped too: its runtime is just as dead);
 *  - `isWorking` clears on them and on any other working Codex session of the host;
 *  - the host's Codex prompt actions still queued or running fail, and their locks are released.
 * Stop and Claude actions are not touched. Returns the sessions whose row changed, for the caller
 * to broadcast after the commit. The owner-of-record rule comes from session-ownership.
 */
export async function degradeCodexSessionsOfRestartedHost(
	supervisorId: string,
	deps: { afterWrites?: (tx: unknown) => Promise<void> } = {},
): Promise<string[]> {
	return withTransaction(async (tx) => {
		const owned = await tx
			.select({
				sessionId: managedSessions.sessionId,
				managedState: managedSessions.managedState,
				isWorking: sessions.isWorking,
			})
			.from(managedSessions)
			.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(and(sessionOwnedBy(supervisorId), eq(sessions.agentType, "codex_cli")));
		const allIds: string[] = owned.map((row: { sessionId: string }) => row.sessionId);
		const toDegrade: string[] = owned
			.filter(
				(row: { managedState: string }) => !TERMINAL_MANAGED_STATES.includes(row.managedState),
			)
			.map((row: { sessionId: string }) => row.sessionId);
		const toClear: string[] = owned
			.filter((row: { isWorking: boolean }) => row.isWorking)
			.map((row: { sessionId: string }) => row.sessionId);
		const timestamp = nowIso();

		for (const ids of inChunks(toDegrade)) {
			await tx
				.update(managedSessions)
				.set({
					managedState: "degraded",
					providerSyncState: "failed",
					providerSyncError: HOST_RESTARTED_SYNC_ERROR,
					updatedAt: timestamp,
				})
				.where(inArray(managedSessions.sessionId, ids));
		}
		for (const ids of inChunks(toClear)) {
			await tx
				.update(sessions)
				.set({ isWorking: false, currentTurnStartedAt: null })
				.where(inArray(sessions.sessionId, ids));
		}

		for (const ids of inChunks(allIds)) {
			const open: Array<{ id: string; status: string }> = await tx
				.select({ id: controlActions.id, status: controlActions.status })
				.from(controlActions)
				.where(
					and(
						eq(controlActions.actionType, "prompt"),
						inArray(controlActions.status, ["queued", "running"]),
						inArray(controlActions.sessionId, ids),
					),
				);
			if (open.length === 0) continue;
			const actionIds = open.map((action) => action.id);
			await tx
				.update(controlActions)
				.set({
					status: "failed",
					error: HOST_RESTARTED_PROMPT_ERROR,
					finishedAt: timestamp,
					updatedAt: timestamp,
				})
				.where(inArray(controlActions.id, actionIds));
			await tx
				.update(managedSessions)
				.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
				.where(inArray(managedSessions.activeControlActionId, actionIds));
			for (const action of open) {
				if (action.status === "queued") await markAuditExpiredUnclaimed(tx, action.id);
			}
		}

		await deps.afterWrites?.(tx);
		return [...new Set([...toDegrade, ...toClear])];
	});
}

export async function attachManagedSessionToLaunch(input: {
	sessionId: string;
	launchRequestId: string;
	supervisorId: string;
	correlationSource?: string | null;
}) {
	const timestamp = nowIso();
	const [existingManaged] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);
	// The claiming supervisor is authenticated, so its row exists unless it was
	// deleted since; its name is the session's machine (a supervisor-launched
	// session is on its supervisor's host, whatever a relay reports for it). Read
	// inside the write, so the hot path costs no extra statement; supervisor names
	// are cleaned when written, so the copy is already clean.
	const supervisorHost = sql<
		string | null
	>`(SELECT ${supervisors.hostName} FROM ${supervisors} WHERE ${supervisors.id} = ${input.supervisorId})`;
	const hostName = existingManaged?.hostName ?? supervisorHost;
	// Narrow Drizzle row's `string` to ManagedState. Every producer only
	// writes union members, so this cast is safe at the boundary.
	const resolvedManagedState: ManagedState =
		(existingManaged?.managedState as ManagedState | undefined) ?? "linked";

	await getDb()
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
			hostName,
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
				hostName,
				hostAffinityReason: existingManaged?.hostAffinityReason ?? "manual_target",
				updatedAt: timestamp,
			},
		});

	const [managedRow] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	return managedRow ? mapManagedSession(managedRow) : null;
}

export async function listManagedSessionsNeedingSync(supervisorId: string) {
	// Explicit column selection (rather than a bare .select()) keeps the row
	// shape equal to managedSessions.$inferSelect once launchRequests is
	// joined in for owner-of-record routing, so mapManagedSession still
	// receives a managed row.
	const rows = await getDb()
		.select({
			sessionId: managedSessions.sessionId,
			launchRequestId: managedSessions.launchRequestId,
			supervisorId: managedSessions.supervisorId,
			providerSessionId: managedSessions.providerSessionId,
			providerThreadId: managedSessions.providerThreadId,
			managedState: managedSessions.managedState,
			correlationSource: managedSessions.correlationSource,
			desiredThreadTitle: managedSessions.desiredThreadTitle,
			providerThreadTitle: managedSessions.providerThreadTitle,
			providerSyncState: managedSessions.providerSyncState,
			providerSyncError: managedSessions.providerSyncError,
			lastProviderSyncAt: managedSessions.lastProviderSyncAt,
			providerProtocolVersion: managedSessions.providerProtocolVersion,
			providerCapabilitySnapshot: managedSessions.providerCapabilitySnapshot,
			activeControlActionId: managedSessions.activeControlActionId,
			controlLockExpiresAt: managedSessions.controlLockExpiresAt,
			hostName: managedSessions.hostName,
			hostAffinityReason: managedSessions.hostAffinityReason,
			createdAt: managedSessions.createdAt,
			updatedAt: managedSessions.updatedAt,
		})
		.from(managedSessions)
		.leftJoin(launchRequests, ownerLaunchJoin)
		.where(
			and(
				sessionOwnedBy(supervisorId),
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
	await getDb()
		.update(sessions)
		.set({ watcherState: state, watcherLastRunAt: nowIso() })
		.where(eq(sessions.sessionId, sessionId));
}

/** Mark the last time a user prompt landed so race-control sees it. */
export async function stampUserPrompt(sessionId: string): Promise<void> {
	await getDb()
		.update(sessions)
		.set({ watcherLastUserPromptAt: nowIso() })
		.where(eq(sessions.sessionId, sessionId));
}
