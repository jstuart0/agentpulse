import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import {
	HOST_RESTARTED_FORK_SYNC_ERROR,
	HOST_RESTARTED_SYNC_ERROR,
} from "../../shared/managed-messages.js";
import { resumeFailureMessage } from "../../shared/session-resume.js";
import { INTERRUPTED_BEFORE_SEND_CODE, INTERRUPTED_STATUS } from "../../shared/stop-turn.js";
import { isWithinWindow } from "../../shared/time-window.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedState,
	Session,
} from "../../shared/types.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	users,
} from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { withTransaction } from "../db/with-transaction.js";
import { markAuditExpiredUnclaimed } from "./ai/dispatch-audit-service.js";
import { stripAndRedact } from "./ai/redactor.js";
import { closeApprovalsForSession } from "./codex-approvals.js";
import { failResumeAction } from "./control-actions.js";
import {
	type NormalizedEvent,
	isApprovalResolvedEventName,
	isServerOnlyEventName,
	isSessionResumedEventName,
} from "./event-normalizer.js";
import {
	type ManagedInsertDeps,
	type ManagedInsertResult,
	insertManagedEvents,
	insertNormalizedEvents,
} from "./event-processor.js";
import { constrainForkRowContent, normalizeForkRowPayload } from "./fork-call-row.js";
import { cleanMachineName } from "./machine-name.js";
import { generateSessionName } from "./name-generator.js";
import { ownerForNewSession } from "./session-attribution.js";
import { mapSessionDto } from "./session-dto.js";
import {
	SessionOwnershipError,
	assertSupervisorCanWriteSession,
	assertSupervisorCanWriteSessionInfo,
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
 * Agents whose host reports when a turn is over, so a terminal or idle report can end the working state
 * without waiting for a hook (AGEN-110: a stopped Claude session, which no Stop hook will ever reach).
 */
function endsWithManagedRuntime(agentType: string | null | undefined): boolean {
	return agentType === "codex_cli" || agentType === "claude_code";
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
	if (!metadata || !SERVER_OWNED_METADATA_KEYS.some((key) => key in metadata)) return metadata;
	const rest = { ...metadata };
	for (const key of SERVER_OWNED_METADATA_KEYS) delete rest[key];
	return rest;
}

/**
 * Keys of a session's metadata only the server writes. `permissionWait` is the record of what the session
 * is blocked on, from hook events and approval rows. `managedResumeAt` fences a resumed session against a
 * stale or forged `SessionEnd` and is never cleared (AGEN-115, D14): a supervisor can neither set nor clear it.
 * `endedByEvent` is the hook terminal latch (D21); the server sets it for a stopped Claude row (AGEN-110).
 */
const SERVER_OWNED_METADATA_KEYS = [
	"permissionWait",
	"managedResumeAt",
	"endedByEvent",
	// A takeover fork's markers (AGEN-117 T6, T18): `forkedFromSessionId` is what makes the hook path drop a
	// session's posts, and `peerTurn` holds the redacted text of a message a stranger sent it. A supervisor
	// report can write none of them.
	"forkedFromSessionId",
	"forkPermissionBranch",
	"peerTurn",
	// What a fork was started with (AGEN-119..123): written by the takeover's settle from the host's report.
	"forkOptions",
	// The host owner who consented to those options (H1): written by the settle's insert, never by a report.
	"forkOptionsConsentUserId",
] as const;

// Test seam (AGEN-115): runs after a report's open-action check and before its writes, so a test can land a
// settle of the same action in that window.
let afterResumeCheckHook: (() => Promise<void>) | null = null;
export function _setAfterResumeCheckHookForTest(hook: (() => Promise<void>) | null): void {
	afterResumeCheckHook = hook;
}

/**
 * Refuses a report that names a resume action unless that action is still open for this session, in the
 * report's own transaction and before anything is written. On Postgres the action row is locked
 * `FOR SHARE`, so a concurrent settle (which updates it) waits for the report's writes instead of
 * releasing rows underneath them.
 */
async function requireOpenResumeAction(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
	resumeActionId: string,
): Promise<void> {
	const read = tx
		.select({ id: controlActions.id })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.id, resumeActionId),
				eq(controlActions.sessionId, sessionId),
				eq(controlActions.actionType, "resume"),
				inArray(controlActions.status, ["queued", "running"]),
			),
		)
		.limit(1);
	const [open] = await (config.dialect === "postgres" ? read.for("share") : read);
	if (!open) throw new SessionOwnershipError("launch_mismatch");
}

async function inTransactionOf<T>(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	alreadyInside: boolean,
	fn: (tx: any) => Promise<T>,
): Promise<T> {
	return alreadyInside ? fn(db) : withTransaction(fn);
}

/**
 * A stopped Claude row holds the hook terminal latch (D21's `endedByEvent`, 30 s) so a hook from the dying
 * process can't reopen it, and a LIVE report that starts a new run on a stopped row (a managed prompt) lifts
 * it, so the new run's own Stop hook isn't held. A replay (an outbox resend of something older) never lifts
 * it: it says nothing about a run starting now. The hook path already sets, honours and exempts
 * `UserPromptSubmit` and `SessionStart` from it; this is the managed path's half. Claude only, judged by the
 * launch's agent type (what the host was asked to run) before the session row's, which a hook can create
 * first with a type of its choosing. Codex hooks post under the thread id and never reach the session row.
 * The launch is read only when a change is on the table, so an ordinary report costs nothing extra.
 */
async function claudeStopLatchChange(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	input: ManagedSessionStateInput,
	existingManaged: { managedState: string } | undefined,
	existingSession: { agentType: string | null } | undefined,
	replay: boolean,
): Promise<"set" | "clear" | null> {
	const change: "set" | "clear" | null =
		input.managedState === "stopped"
			? "set"
			: existingManaged?.managedState === "stopped" && !isTerminalStateReport(input) && !replay
				? "clear"
				: null;
	if (change === null || !existingSession) return null;
	const [launch] = await db
		.select({ agentType: launchRequests.agentType })
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, input.sessionId))
		.limit(1);
	return (launch?.agentType ?? existingSession.agentType) === "claude_code" ? change : null;
}

/** The most a message's text is kept at (the host cuts it to this too). */
export const PEER_TURN_MAX_CHARS = 1024;

/**
 * What the server keeps of a message a stranger sent a fork: the text, run through the approval pipeline's
 * redaction, or, if redaction (or the stripping of invisible characters) changed anything, no text at all and
 * a flag, so the reader is shown fixed words instead of something that may hold a secret.
 */
export function peerTurnRecord(
	text: string,
	at: string,
): { text: string | null; hidden: boolean; at: string } {
	// The host found no line Claude tags as a peer's: stored as "not captured" (no text, not hidden), never guessed.
	if (text.trim() === "") return { text: null, hidden: false, at };
	const cut = text.slice(0, PEER_TURN_MAX_CHARS);
	const { text: cleaned, hits } = stripAndRedact(cut);
	const changed = hits.length > 0 || cleaned !== cut;
	return changed ? { text: null, hidden: true, at } : { text: cleaned, hidden: false, at };
}

async function writeManagedSessionState(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	inTx: boolean,
	supervisorId: string,
	input: ManagedSessionStateInput,
	options: { replay?: boolean },
	resumeActionId: string | null,
) {
	const supervisorMetadata = withoutServerOwnedMetadata(input.metadata);
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

	// A Codex or Claude host reporting idle means its turn is over (completed, failed to start, or the
	// runtime closed), whatever event did or didn't arrive; for a stopped Claude session no Stop hook will
	// ever come, so this is the only thing that ends the turn. Folded into the update this function
	// already makes, so it costs no statement. A repeat after a Completed event moves nothing:
	// the completion is stamped only if the session was still working.
	// A terminal report ends the session, so a turn can't still be running (the excluded closing report included).
	if (isTerminalStateReport(input) && endsWithManagedRuntime(existingSession?.agentType)) {
		sessionUpdates.isWorking = false;
		sessionUpdates.currentTurnStartedAt = null;
	}
	if (input.status === "idle" && endsWithManagedRuntime(existingSession?.agentType)) {
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
			const [launch] = await db
				.select({ requestedByUserId: launchRequests.requestedByUserId })
				.from(launchRequests)
				.where(eq(launchRequests.id, input.launchRequestId))
				.limit(1);
			launchRequesterUserId = launch?.requestedByUserId ?? null;
		}
		// A host kept when its owner was disabled still works, but its owner is
		// gone: the join leaves a disabled owner out, so the session is unowned.
		const [supervisorRow] = await db
			.select({ ownerUserId: users.id })
			.from(supervisors)
			.leftJoin(users, and(eq(users.id, supervisors.ownerUserId), isNull(users.disabledAt)))
			.where(eq(supervisors.id, supervisorId))
			.limit(1);
		const owner = ownerForNewSession({
			launchRequesterUserId,
			supervisorOwnerUserId: supervisorRow?.ownerUserId ?? null,
		});

		await db
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
		await inTransactionOf(db, inTx, async (tx) => {
			const updates: Record<string, unknown> = { ...sessionUpdates };
			const latch = await claudeStopLatchChange(
				tx,
				input,
				existingManaged,
				existingSession,
				options.replay === true,
			);
			// The text of a message a stranger sent a takeover fork, from the host's degraded report: kept only in
			// the server-owned `peerTurn`, redacted, and only for a session the server itself marked as a fork.
			const peerText =
				input.managedState === "degraded" && typeof input.peerTurnText === "string"
					? input.peerTurnText
					: null;
			// A successful resume leaves the stranger's message behind: it is cleared with the sync error it explained.
			const clearsPeer = input.clearProviderSyncError === true && resumeActionId !== null;
			if (supervisorMetadata || latch !== null || peerText !== null || clearsPeer) {
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
				const { endedByEvent: heldLatch, ...rest } = {
					...(fresh?.metadata ?? {}),
					...supervisorMetadata,
				} as Record<string, unknown>;
				// The latch is the server's: set when a Claude row is reported stopped, lifted when a new run
				// starts on it, and otherwise left exactly as the row had it.
				const merged: Record<string, unknown> =
					latch === "set"
						? { ...rest, endedByEvent: { at: timestamp } }
						: latch === "clear" || heldLatch === undefined
							? rest
							: { ...rest, endedByEvent: heldLatch };
				if (peerText !== null && typeof merged.forkedFromSessionId === "string") {
					merged.peerTurn = peerTurnRecord(peerText, timestamp);
				} else if (clearsPeer) {
					merged.peerTurn = undefined;
				}
				updates.metadata = merged;
			}
			await tx.update(sessions).set(updates).where(eq(sessions.sessionId, input.sessionId));
		});
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
	// A replayed report is older than the restart that degraded this row: its process is gone, so
	// it can't make the row managed again. A live report still wins, which is how a later
	// rebind will bring the session back.
	const heldDegraded =
		options.replay === true &&
		!isTerminalStateReport(input) &&
		existingManaged?.managedState === "degraded" &&
		(existingManaged.providerSyncError === HOST_RESTARTED_SYNC_ERROR ||
			existingManaged.providerSyncError === HOST_RESTARTED_FORK_SYNC_ERROR);
	const providerSyncState =
		(heldDegraded ? undefined : input.providerSyncState) ??
		existingManaged?.providerSyncState ??
		"pending";
	// Clearing is explicit, and only for a report that belongs to an open resume (checked at the top). A
	// held replay never clears, and a plain null never does: the restart marker must survive it.
	const clearsSyncError =
		resumeActionId !== null && input.clearProviderSyncError === true && !heldDegraded;
	const providerSyncError = clearsSyncError
		? null
		: ((heldDegraded ? undefined : input.providerSyncError) ??
			existingManaged?.providerSyncError ??
			null);
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

	const [managedRow] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, input.sessionId))
		.limit(1);

	return { currentSession, managedRow };
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
	const resumeActionId =
		typeof input.resumeActionId === "string" && input.resumeActionId !== ""
			? input.resumeActionId
			: null;
	// Who owns the session is judged first, so a refusal for a foreign host never reveals the state of an action.
	await assertSupervisorCanWriteSession(supervisorId, input.sessionId, {
		launchRequestId: input.launchRequestId,
	});
	// A report that belongs to a resume checks that action and writes in one transaction; every other
	// report runs exactly as it always did (no extra read, no transaction of its own).
	const { currentSession, managedRow } =
		resumeActionId === null
			? await writeManagedSessionState(getDb(), false, supervisorId, input, options, null)
			: await withTransaction(async (tx) => {
					await requireOpenResumeAction(tx, input.sessionId, resumeActionId);
					await afterResumeCheckHook?.();
					return writeManagedSessionState(tx, true, supervisorId, input, options, resumeActionId);
				});

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
		isSessionResumedEventName(event.providerEventType) ||
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
	// A fork's rows are normalized because the session is a fork (its carrier launch is the takeover's, written
	// with the session's `forkedFromSessionId`), never because the sender says so (review M1). The ownership read
	// already joins the launch, so this costs no statement.
	const { isFork } = await assertSupervisorCanWriteSessionInfo(supervisorId, sessionId);
	// The whole batch is refused: one forged event poisons the rest.
	if (events.some(isReservedEvent)) throw new ReservedEventTypeError();
	const nowMs = Date.now();
	return events.map((event) => {
		const rawPayload = normalizeForkRowPayload(event.rawPayload ?? {}, isFork);
		return {
			eventType: event.eventType,
			category: event.category,
			source: event.source ?? (event.category === "prompt" ? "managed_control" : "launch_system"),
			content: isFork
				? constrainForkRowContent(event, rawPayload, event.content ?? null)
				: (event.content ?? null),
			isNoise: event.isNoise ?? false,
			providerEventType: event.providerEventType ?? null,
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload,
			occurredAt: acceptedOccurredAt(supervisorId, event.occurredAt, nowMs),
		};
	});
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
			...deps,
			// Inside the receipt transaction, on the batch as sent: a row the window dropped still counts.
			// The production update always runs first; a test's seam is added after it, never instead of it.
			afterRows: async (tx) => {
				await applyManagedTurnBoundaries(tx, sessionId, prepared, { late: options.late === true });
				await deps?.afterRows?.(tx);
			},
		},
	);
}

/** The slice of an event the turn rules read; a NormalizedEvent satisfies it. */
export interface TurnBoundaryEvent {
	eventType: string;
	rawPayload?: Record<string, unknown> | null;
}

/** `end_interrupted`: a fork's turn a person stopped (AGEN-119). It ends the turn like `end` and also acknowledges it, so the session reads IDLE rather than WAITING for a result nobody is waiting for. */
type TurnChange = "start" | "launch_start" | "end" | "end_interrupted" | "stopped";

/**
 * Which runtime's marker an event carries: a Codex app-server's (`codexRuntime`) or a takeover fork's
 * long-lived Claude stream (`claudeStreamRuntime`, AGEN-117 T18). The marker decides which agent type's
 * launch the event may move, so a Claude marker on a Codex row, or the reverse, changes nothing.
 */
type TurnAgent = "codex_cli" | "claude_code";

function markerAgent(event: TurnBoundaryEvent): TurnAgent | null {
	if (event.rawPayload?.codexRuntime === true) return "codex_cli";
	if (event.rawPayload?.claudeStreamRuntime === true) return "claude_code";
	return null;
}

/** What one event does to a managed session's turn, or null. The marker is what makes it a managed runtime's. */
function turnChangeOf(
	event: TurnBoundaryEvent,
	late: boolean,
): { change: TurnChange; agent: TurnAgent | null } | null {
	const agent = markerAgent(event);
	switch (event.eventType) {
		case "HeadlessPromptSubmitted":
			return agent && !late ? { change: "start", agent } : null;
		case "ManagedSessionStart":
			return agent && !late ? { change: "launch_start", agent } : null;
		case "HeadlessPromptCompleted":
			return agent ? { change: "end", agent } : null;
		case "HeadlessPromptFailed":
			if (!agent) return null;
			return {
				change:
					agent === "claude_code" &&
					(event.rawPayload?.status === INTERRUPTED_STATUS ||
						event.rawPayload?.code === INTERRUPTED_BEFORE_SEND_CODE)
						? "end_interrupted"
						: "end",
				agent,
			};
		case "ManagedSessionStopped":
			return { change: "stopped", agent: null };
		default:
			return null;
	}
}

/**
 * A managed turn's working state, from the events a supervisor reports (AGEN-91 D5, AGEN-117 T18). Codex's
 * own hooks post under the thread id, not this session's id, and a takeover fork's hooks are dropped
 * outright, so nothing else flips these columns. The last relevant event in the batch wins. A late report
 * (an outbox replay) can end a turn but never start one. `db` is the receipt transaction's `tx` when there is
 * one.
 *
 * A launched Claude's own hooks own its working state, so a launched Claude row is touched only by
 * `ManagedSessionStopped` (AGEN-110): a stopped process will never send the Stop hook, so the host's stop
 * event clears the working flag and the turn start. A takeover fork's turn events carry the Claude marker and
 * move the row exactly as a Codex turn's do.
 *
 * Statements: none for a batch with no relevant event (a launched Claude's prompt or completion lacks the
 * marker, so no agent-type read is needed to decide that); one guarded UPDATE otherwise. That includes
 * ManagedSessionStopped, which carries no marker and clears working on either agent's row. The guard keeps
 * a marker on a row of the other agent from changing anything, and it reads the launch's agent type (what
 * the host was asked to run) before the session row's, which a hook can create first with a type of its
 * choosing.
 */
export async function applyManagedTurnBoundaries(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	sessionId: string,
	incoming: readonly TurnBoundaryEvent[],
	options: { late: boolean },
): Promise<void> {
	let last: { change: TurnChange; agent: TurnAgent | null } | null = null;
	for (const event of incoming) last = turnChangeOf(event, options.late) ?? last;
	if (last === null) return;
	// A Claude turn marker moves only a takeover fork's row. A launched Claude's own hooks own its working
	// state, so the same marker on one of those changes nothing (the supervisor that owns it has no reason to
	// send it). Read from the launch, which only a launch request writes; one extra statement, only for a batch
	// that carries the Claude marker.
	if (last.agent === "claude_code") {
		const [launch] = await db
			.select({ metadata: launchRequests.metadata })
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, sessionId))
			.limit(1);
		if ((launch?.metadata as Record<string, unknown> | null)?.boundObservedSession !== true) return;
	}

	const now = new Date().toISOString();
	const updates: Record<string, unknown> =
		last.change === "stopped"
			? { isWorking: false, currentTurnStartedAt: null }
			: last.change === "end" || last.change === "end_interrupted"
				? {
						isWorking: false,
						currentTurnStartedAt: null,
						lastAgentTurnCompletedAt: now,
						lastActivityAt: now,
						...(last.change === "end_interrupted" ? { lastUserAcknowledgedAt: now } : {}),
					}
				: {
						isWorking: true,
						currentTurnStartedAt: now,
						lastActivityAt: now,
						status: "active",
						endedAt: null,
						// A sent prompt acknowledges whatever came before it; the launch turn has nothing before it.
						...(last.change === "start" ? { lastUserAcknowledgedAt: now } : {}),
					};
	// A stop is reported by the host for either agent; every other change carries its runtime's marker.
	const agents =
		last.agent === null
			? sql`in ('codex_cli', 'claude_code')`
			: last.agent === "claude_code"
				? sql`= 'claude_code'`
				: sql`= 'codex_cli'`;
	await db
		.update(sessions)
		.set(updates)
		.where(
			and(
				eq(sessions.sessionId, sessionId),
				sql`coalesce((select ${launchRequests.agentType} from ${launchRequests} where ${launchRequests.launchCorrelationId} = ${sessions.sessionId}), ${sessions.agentType}) ${agents}`,
			),
		);
}

/** The launch's agent type outranks the session row's (a hook can create the row first, choosing its own). */
const isCodexLaunch = sql`coalesce(${launchRequests.agentType}, ${sessions.agentType}) = 'codex_cli'`;

let DEGRADE_CHUNK = 500;
/** Test seam: a smaller chunk makes the chunk boundary reachable with a handful of rows. */
export function _setDegradeChunkForTest(size: number): void {
	DEGRADE_CHUNK = size;
}
const TERMINAL_MANAGED_STATES: readonly string[] = ["stopped", "completed", "failed"];
const ENDED_SESSION_STATUSES: readonly string[] = ["completed", "failed", "archived"];
export const HOST_RESTARTED_PROMPT_ERROR =
	"The host's supervisor restarted before this prompt was confirmed.";

function inChunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += DEGRADE_CHUNK) out.push(items.slice(i, i + DEGRADE_CHUNK));
	return out;
}

interface OwnedCodexRow {
	sessionId: string;
	isWorking: boolean;
	endedAt: string | null;
	status: string;
	isArchived: boolean;
}

function hasEnded(row: OwnedCodexRow): boolean {
	return row.endedAt !== null || row.isArchived || ENDED_SESSION_STATUSES.includes(row.status);
}

/**
 * A supervisor registered again, so the process (and every app-server) it ran before is gone
 * (AGEN-91 D8). In one transaction, for the Codex sessions that host owns of record:
 *  - every nonterminal session not already stamped becomes `degraded` with
 *    HOST_RESTARTED_SYNC_ERROR, which a replayed report can't undo (a rename-failure row is stamped
 *    too: its runtime is just as dead). A row already stamped is left alone, so a second restart
 *    writes nothing for it;
 *  - `isWorking` clears on them and on any other working Codex session of the host. A session that
 *    hasn't ended gets `lastActivityAt` = now, so the normal 5 and 30 minute windows apply instead of
 *    one sweep completing it, and one that was working reads WAITING (its turn was cut short);
 *  - the host's Codex prompt actions still queued or running fail, and their locks are released.
 * Stop and Claude actions are not touched. "Codex" is the launch's agent type, the session row's
 * only when there is no launch. Returns the sessions to announce: those changed that haven't ended.
 */
export async function degradeCodexSessionsOfRestartedHost(
	supervisorId: string,
	deps: { afterWrites?: (tx: unknown) => Promise<void> } = {},
): Promise<string[]> {
	return withTransaction(async (tx) => {
		const columns = {
			sessionId: managedSessions.sessionId,
			isWorking: sessions.isWorking,
			endedAt: sessions.endedAt,
			status: sessions.status,
			isArchived: sessions.isArchived,
		};
		const ownedCodex = and(sessionOwnedBy(supervisorId), isCodexLaunch);
		// A resume in flight dies with the process it was starting: settled first, in this transaction. A
		// takeover's rows are released (so the session is observed again, not degraded); a recovery's row
		// stays and is degraded below with the rest.
		const openResumes: Array<{
			action: typeof controlActions.$inferSelect;
			hostName: string | null;
		}> = await tx
			.select({ action: controlActions, hostName: managedSessions.hostName })
			.from(controlActions)
			.innerJoin(managedSessions, eq(managedSessions.sessionId, controlActions.sessionId))
			.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(
				and(
					ownedCodex,
					eq(controlActions.actionType, "resume"),
					inArray(controlActions.status, ["queued", "running"]),
				),
			);
		for (const { action, hostName } of openResumes) {
			const kind =
				(action.metadata as { resumeKind?: unknown } | null)?.resumeKind === "recovery"
					? "recovery"
					: "takeover";
			await failResumeAction(
				tx,
				action,
				resumeFailureMessage("restart", hostName ?? "The host", kind),
			);
		}
		const needsDegrade: OwnedCodexRow[] = await tx
			.select(columns)
			.from(managedSessions)
			.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(
				and(
					ownedCodex,
					notInArray(managedSessions.managedState, [...TERMINAL_MANAGED_STATES]),
					or(
						isNull(managedSessions.providerSyncError),
						ne(managedSessions.providerSyncError, HOST_RESTARTED_SYNC_ERROR),
					),
				),
			);
		const working: OwnedCodexRow[] = await tx
			.select(columns)
			.from(managedSessions)
			.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(and(ownedCodex, eq(sessions.isWorking, true)));

		const rows = new Map<string, OwnedCodexRow>();
		for (const row of [...needsDegrade, ...working]) rows.set(row.sessionId, row);
		const timestamp = nowIso();
		const live = [...rows.values()].filter((row) => !hasEnded(row));
		const workingLive = live.filter((row) => row.isWorking).map((row) => row.sessionId);
		const workingEnded = [...rows.values()]
			.filter((row) => hasEnded(row) && row.isWorking)
			.map((row) => row.sessionId);

		for (const ids of inChunks(needsDegrade.map((row) => row.sessionId))) {
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
		for (const ids of inChunks(live.map((row) => row.sessionId))) {
			await tx
				.update(sessions)
				.set({ lastActivityAt: timestamp })
				.where(inArray(sessions.sessionId, ids));
		}
		for (const ids of inChunks(workingLive)) {
			await tx
				.update(sessions)
				.set({ isWorking: false, currentTurnStartedAt: null, lastAgentTurnCompletedAt: timestamp })
				.where(inArray(sessions.sessionId, ids));
		}
		for (const ids of inChunks(workingEnded)) {
			await tx
				.update(sessions)
				.set({ isWorking: false, currentTurnStartedAt: null })
				.where(inArray(sessions.sessionId, ids));
		}

		// Only sessions with an open prompt are read, whatever the host's history holds.
		const open: Array<{ id: string; status: string }> = await tx
			.select({ id: controlActions.id, status: controlActions.status })
			.from(controlActions)
			.innerJoin(managedSessions, eq(managedSessions.sessionId, controlActions.sessionId))
			.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(
				and(
					ownedCodex,
					eq(controlActions.actionType, "prompt"),
					inArray(controlActions.status, ["queued", "running"]),
				),
			);
		for (const chunk of inChunks(open)) {
			const actionIds = chunk.map((action) => action.id);
			await tx
				.update(controlActions)
				.set({
					status: "failed",
					error: HOST_RESTARTED_PROMPT_ERROR,
					finishedAt: timestamp,
					updatedAt: timestamp,
				})
				.where(
					and(
						inArray(controlActions.id, actionIds),
						inArray(controlActions.status, ["queued", "running"]),
					),
				);
			await tx
				.update(managedSessions)
				.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
				.where(inArray(managedSessions.activeControlActionId, actionIds));
			for (const action of chunk) {
				if (action.status === "queued") await markAuditExpiredUnclaimed(tx, action.id);
			}
		}

		await deps.afterWrites?.(tx);
		return live.map((row) => row.sessionId);
	});
}

/**
 * A supervisor registered again, so the long-lived Claude process of every fork it held is gone (AGEN-117
 * T10, P3-I19). The Codex pass above is keyed on the launch's agent type; a fork is a Claude launch whose
 * session row names its source, so it needs its own. For the forks that host owns of record and that haven't
 * ended: the row becomes `degraded` with HOST_RESTARTED_FORK_SYNC_ERROR (which a replayed report can't undo),
 * the working flag clears (a cut turn reads WAITING), and the prompts and recovery resumes still open for
 * them fail with fixed words and release their locks. A row already stamped is left alone, so a second
 * restart writes nothing. Returns the sessions changed, to announce.
 */
export async function degradeClaudeForksOfRestartedHost(
	supervisorId: string,
	deps: { afterWrites?: (tx: unknown) => Promise<void> } = {},
): Promise<string[]> {
	return withTransaction(async (tx) => {
		const forks: Array<{
			sessionId: string;
			isWorking: boolean;
			stamped: boolean;
			hostName: string | null;
		}> = (
			await tx
				.select({
					sessionId: managedSessions.sessionId,
					isWorking: sessions.isWorking,
					syncError: managedSessions.providerSyncError,
					hostName: managedSessions.hostName,
				})
				.from(managedSessions)
				.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
				.leftJoin(launchRequests, ownerLaunchJoin)
				.where(
					and(
						sessionOwnedBy(supervisorId),
						isNotNull(jsonExtractText(sessions.metadata, "$.forkedFromSessionId")),
						notInArray(managedSessions.managedState, [...TERMINAL_MANAGED_STATES]),
					),
				)
		).map(
			(row: {
				sessionId: string;
				isWorking: boolean;
				syncError: string | null;
				hostName: string | null;
			}) => ({
				sessionId: row.sessionId,
				isWorking: row.isWorking,
				stamped: row.syncError === HOST_RESTARTED_FORK_SYNC_ERROR,
				hostName: row.hostName,
			}),
		);
		if (forks.length === 0) return [];
		const timestamp = nowIso();
		const hostNames = new Map(forks.map((fork) => [fork.sessionId, fork.hostName]));

		// Open actions of every fork this host holds, a stamped one included: the process they were for is gone.
		// A recovery ends through the one resume settle (with the resume words); a prompt fails with its own.
		for (const ids of inChunks(forks.map((fork) => fork.sessionId))) {
			const open: Array<typeof controlActions.$inferSelect> = await tx
				.select()
				.from(controlActions)
				.where(
					and(
						inArray(controlActions.sessionId, ids),
						inArray(controlActions.actionType, ["prompt", "resume"]),
						inArray(controlActions.status, ["queued", "running"]),
					),
				);
			for (const action of open) {
				if (action.actionType === "resume") {
					await failResumeAction(
						tx,
						action,
						resumeFailureMessage(
							"restart",
							hostNames.get(action.sessionId ?? "") ?? "The host",
							"recovery",
							"claude_code",
						),
					);
				} else {
					await tx
						.update(controlActions)
						.set({
							status: "failed",
							error: HOST_RESTARTED_PROMPT_ERROR,
							finishedAt: timestamp,
							updatedAt: timestamp,
						})
						.where(
							and(
								eq(controlActions.id, action.id),
								inArray(controlActions.status, ["queued", "running"]),
							),
						);
					await tx
						.update(managedSessions)
						.set({ activeControlActionId: null, controlLockExpiresAt: null, updatedAt: timestamp })
						.where(eq(managedSessions.activeControlActionId, action.id));
				}
			}
		}

		const fresh = forks.filter((fork) => !fork.stamped);
		for (const ids of inChunks(fresh.map((fork) => fork.sessionId))) {
			await tx
				.update(managedSessions)
				.set({
					managedState: "degraded",
					providerSyncState: "failed",
					providerSyncError: HOST_RESTARTED_FORK_SYNC_ERROR,
					updatedAt: timestamp,
				})
				.where(inArray(managedSessions.sessionId, ids));
			await tx
				.update(sessions)
				.set({ lastActivityAt: timestamp })
				.where(inArray(sessions.sessionId, ids));
		}
		for (const ids of inChunks(
			fresh.filter((fork) => fork.isWorking).map((fork) => fork.sessionId),
		)) {
			await tx
				.update(sessions)
				.set({ isWorking: false, currentTurnStartedAt: null, lastAgentTurnCompletedAt: timestamp })
				.where(inArray(sessions.sessionId, ids));
		}
		await deps.afterWrites?.(tx);
		return fresh.map((fork) => fork.sessionId);
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
