import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
/**
 * Answering managed Codex approvals from AgentPulse (AGEN-87): the one service
 * that owns the `codex_approvals` and `codex_approval_audit` tables.
 *
 * States: pending -> answered -> closed, and pending -> closed. Every transition
 * is one guarded UPDATE (`WHERE status = ...`), so two writers race and exactly
 * one wins; a row never leaves `closed`, `closed_reason` is written once (only
 * `closeApproval` writes it), `decision` is written once (only the answer's
 * guarded update), and an accept is issued to the host only through one guarded
 * statement that also checks no Stop is queued or running.
 *
 * What a person is shown is built, redacted and hashed here, never trusted from
 * the host. The hash is an ETag for that stored text, not proof that a person
 * read it or that the display matches execution: the boundary is the trusted
 * host (see shared/codex-approvals.ts).
 *
 * Nothing the agent wrote reaches a log line or an event: events carry fixed
 * words, logs carry ids and enum values.
 */
import { AGENT_OPENED_WORDS } from "../../shared/claude-fork-subagents.js";
import {
	APPROVAL_DECISIONS,
	APPROVAL_REQUEST_KINDS,
	APPROVAL_RESOLVED_EVENT_TYPE,
	type ApprovalAnswerRefusal,
	type ApprovalClosedReason,
	type ApprovalDecision,
	type ApprovalReportRefusal,
	type ApprovalRequestKind,
	type ApprovalStatus,
	CODEX_ACCEPT_DELIVERY_WINDOW_MS,
	CODEX_APPROVAL_LIMITS,
	CODEX_APPROVAL_TTL_MS,
	CODEX_CLOSED_VISIBLE_MS,
	CODEX_DECIDED_ELSEWHERE_VISIBLE_MS,
	CODEX_NEW_ROW_GRACE_MS,
	CODEX_OUTCOME_UNKNOWN_AFTER_MS,
	type ClaudePeerTurnNotice,
	type CodexApprovalAck,
	type CodexApprovalAnswer,
	type CodexApprovalDecisionResponse,
	type CodexApprovalDetail,
	type CodexApprovalHost,
	type CodexApprovalList,
	type CodexApprovalOutcome,
	type CodexApprovalPresentation,
	type CodexApprovalReportRequest,
	type CodexApprovalReportResponse,
	type CodexApprovalResolved,
	type CodexApprovalSummary,
	type CodexApprovalSyncRequest,
	type CodexApprovalSyncResponse,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
	OPEN_APPROVAL_STATUSES,
	TRACKER_OUTCOMES,
	TRACKER_OUTCOME_TABLE,
	type TrackerOutcome,
	approvalWaitId,
} from "../../shared/codex-approvals.js";
import { parseAppliedForkOptions } from "../../shared/session-resume.js";
import type { Actor, InstanceModeName } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	codexApprovalAudit,
	codexApprovals,
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	users,
} from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { withTransaction } from "../db/with-transaction.js";
import { logAdminAction } from "./audit-log.js";
import {
	NotOwnerError,
	assertCanAnswerApproval,
	canReadSession,
	mayAnswerApproval,
	mayDriveForkOptions,
} from "./authorization.js";
import { mcpReportServerApplied, parseClaudeToolReport } from "./claude-tool-report.js";
import {
	type BuiltPresentation,
	type PresentationAgent,
	buildPresentation,
	buildPreview,
	touchesAgentConfig,
} from "./codex-approval-presentation.js";
import { type ClosedApproval, closeApproval } from "./codex-approvals-close.js";
import type { InsertPlan } from "./event-dedup.js";
import { applyApprovalWait, persistEvents, reconcileApprovalWait } from "./event-processor.js";
import { modeFromStoredColumn, storedModeColumn } from "./instance-mode.js";
import { notifySessionEvents, notifySessionUpdated } from "./notifier.js";
import {
	getSessionOwnerHostStates,
	ownerLaunchJoin,
	resolveSessionOwner,
	sessionOwnedBy,
} from "./session-ownership.js";
import { getSession } from "./session-tracker.js";

export { closeApproval } from "./codex-approvals-close.js";
export type { ClosedApproval, CloseOptions } from "./codex-approvals-close.js";

// ── refusals ────────────────────────────────────────────────────────────────

export type ApprovalRefusalCode = ApprovalAnswerRefusal | ApprovalReportRefusal;

/**
 * The one error this service throws for an expected refusal. The message is the
 * code, fixed: no part of it comes from the agent or the caller. Phases 4 and 5
 * map `code` to an HTTP status.
 */
export class ApprovalRefusal extends Error {
	constructor(readonly code: ApprovalRefusalCode) {
		super(code);
		this.name = "ApprovalRefusal";
	}
}

export interface ApprovalDeps {
	/** Epoch milliseconds. Tests inject a fake clock. */
	now?: () => number;
	/**
	 * Test seam for the race between a check and the guarded write that follows it:
	 * called after the pre-checks and before the write, so a test can change the row
	 * in that gap. Only code passes `deps`; no request reaches it (a drift test pins
	 * the files that mention it), and without it this is a no-op.
	 */
	afterRead?: (point: "answer" | "issue") => void | Promise<void>;
}

function clockOf(deps?: ApprovalDeps): number {
	return (deps?.now ?? Date.now)();
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
type Tx = any;
type ApprovalRow = typeof codexApprovals.$inferSelect;

const OPEN_STATUSES = OPEN_APPROVAL_STATUSES;

// ── effective state and the one outcome function ───────────────────────────

export interface ApprovalStateInput {
	status: string;
	closedReason: string | null;
	decision: string | null;
	answeredAt: string | null;
	firstDeliveredAt: string | null;
	fencedAt: string | null;
	expiresAt: string;
}

export interface EffectiveApproval {
	state: ApprovalStatus;
	closedReason: ApprovalClosedReason | null;
	outcome: CodexApprovalOutcome | null;
}

function parseMs(value: string | null): number {
	return value === null ? Number.NaN : Date.parse(value);
}

/**
 * The state a reader sees: the stored state, plus what the clock has already
 * decided and the sweep has not yet written (an expired pending row, an accept
 * past its delivery window, an issued accept nobody reported on). One function,
 * so the card, the list and the answer's refusals agree.
 */
export function deriveApprovalOutcome(row: ApprovalStateInput, nowMs: number): EffectiveApproval {
	let state = row.status as ApprovalStatus;
	let reason = row.closedReason as ApprovalClosedReason | null;
	const decision = row.decision as ApprovalDecision | null;
	const issued = row.firstDeliveredAt !== null;

	if (state === "pending" && parseMs(row.expiresAt) <= nowMs) {
		state = "closed";
		reason = "expired";
	} else if (state === "answered") {
		if (decision === "accept") {
			if (!issued && parseMs(row.answeredAt) + CODEX_ACCEPT_DELIVERY_WINDOW_MS < nowMs) {
				state = "closed";
				reason = "answer_lapsed";
			} else if (issued && parseMs(row.firstDeliveredAt) + CODEX_OUTCOME_UNKNOWN_AFTER_MS < nowMs) {
				state = "closed";
				reason = "outcome_unknown";
			}
		} else if (parseMs(row.expiresAt) <= nowMs) {
			state = "closed";
			reason = "applied";
		}
	}

	if (state === "pending") return { state, closedReason: null, outcome: null };
	if (state === "answered") {
		if (decision === "accept") {
			const mayHaveRun = issued && row.fencedAt !== null;
			return { state, closedReason: null, outcome: mayHaveRun ? "may_have_run" : "sending_accept" };
		}
		return { state, closedReason: null, outcome: "sending_decline" };
	}
	return { state: "closed", closedReason: reason, outcome: outcomeOfClosed(reason, decision) };
}

function outcomeOfClosed(
	reason: ApprovalClosedReason | null,
	decision: ApprovalDecision | null,
): CodexApprovalOutcome {
	switch (reason) {
		case "applied":
			if (decision === "accept") return "approved_sent";
			return decision === "cancel" ? "declined_stopped" : "declined";
		case "expired":
			return "expired";
		case "answer_lapsed":
			return "answer_lapsed";
		case "answer_withdrawn":
			return "answer_withdrawn";
		case "revision_changed":
			return "revision_changed";
		case "outcome_unknown":
			return "may_have_run";
		case "interrupted":
			return "turn_ended";
		case "turn_stopped":
			return "turn_stopped";
		case "runtime_gone":
			return "codex_shut_down";
		case "decided_elsewhere":
			return "decided_elsewhere";
		case "session_stopped":
			return decision === "accept" ? "approved_then_stopped" : "session_stopped";
		default:
			return "session_stopped";
	}
}

// ── predicates shared by the guarded statements ─────────────────────────────

/** A Stop is queued or running on this approval's session. */
function stopActiveFor(tx: Tx) {
	return tx
		.select({ one: sql`1` })
		.from(managedSessions)
		.innerJoin(controlActions, eq(controlActions.id, managedSessions.activeControlActionId))
		.where(
			and(
				eq(managedSessions.sessionId, codexApprovals.sessionId),
				eq(controlActions.actionType, "stop"),
				inArray(controlActions.status, ["queued", "running"]),
			),
		);
}

/**
 * A Stop turn (AGEN-119) covers this approval: an `interrupt` action of the session that is queued or running
 * (whatever turn the approval names: the turn id is the host's word, and only one turn runs at a time, review
 * M5), or one done (`succeeded`) whose `targetPromptActionId` is the approval's `turn_id`. A failed one (the
 * turn didn't stop, the host dropped it) lifts the fence, matching the host, which lifts its own. It takes no
 * lock, so unlike a Stop it is found by the session, not through the session's lock holder.
 */
function interruptActiveFor(tx: Tx) {
	return tx
		.select({ one: sql`1` })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.sessionId, codexApprovals.sessionId),
				eq(controlActions.actionType, "interrupt"),
				or(
					inArray(controlActions.status, ["queued", "running"]),
					and(
						eq(controlActions.status, "succeeded"),
						eq(
							jsonExtractText(controlActions.metadata, "$.targetPromptActionId"),
							codexApprovals.turnId,
						),
					),
				),
			),
		);
}

async function turnHasActiveInterrupt(tx: Tx, sessionId: string, turnId: string): Promise<boolean> {
	const rows = await tx
		.select({ one: sql`1` })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.sessionId, sessionId),
				eq(controlActions.actionType, "interrupt"),
				or(
					inArray(controlActions.status, ["queued", "running"]),
					and(
						eq(controlActions.status, "succeeded"),
						eq(jsonExtractText(controlActions.metadata, "$.targetPromptActionId"), turnId),
					),
				),
			),
		)
		.limit(1);
	return rows.length > 0;
}

async function sessionHasActiveStop(tx: Tx, sessionId: string): Promise<boolean> {
	const rows = await tx
		.select({ one: sql`1` })
		.from(managedSessions)
		.innerJoin(controlActions, eq(controlActions.id, managedSessions.activeControlActionId))
		.where(
			and(
				eq(managedSessions.sessionId, sessionId),
				eq(controlActions.actionType, "stop"),
				inArray(controlActions.status, ["queued", "running"]),
			),
		)
		.limit(1);
	return rows.length > 0;
}

// ── a row opening ───────────────────────────────────────────────────────────

/** What opened, for the side effects that run after the transaction commits. */
export interface OpenedApproval {
	approvalId: string;
	sessionId: string;
	requestKind: ApprovalRequestKind;
	fileCount: number;
	/** Whose request: the session's agent, from its row. */
	agent: PresentationAgent;
	/** A `claude_tool` request's tool (`WebFetch`, `Read` or `Agent`). */
	tool: string | null;
	/** A subagent of the turn asked (AGEN-120). */
	fromSubagent?: boolean;
}

// ── side effects, after commit ──────────────────────────────────────────────

/** Sessions whose permission wait could not be updated after a commit; the next sweep repairs them. */
const waitRepair = new Set<string>();

/** The fixed word an approval closing records on the timeline. */
function resolvedWord(reason: ApprovalClosedReason, decision: ApprovalDecision | null): string {
	switch (reason) {
		case "applied":
			if (decision === "accept") return "approved";
			return decision === "cancel" ? "stopped" : "declined";
		case "expired":
			return "expired";
		case "answer_lapsed":
		case "answer_withdrawn":
		case "revision_changed":
			return "not delivered";
		case "outcome_unknown":
			return "unknown";
		case "decided_elsewhere":
			return "may have run";
		case "interrupted":
		case "runtime_gone":
			return "ended";
		case "session_stopped":
		case "turn_stopped":
			return "stopped";
	}
}

async function writeApprovalEvent(
	sessionId: string,
	event: {
		eventType: string;
		content: string;
		requestKind: ApprovalRequestKind;
		approvalId: string;
	},
	nowMs: number,
): Promise<void> {
	// Straight to the insert, not through the content window: two identical fixed lines
	// for two different requests must both be stored.
	const plan: InsertPlan = {
		retained: [
			{
				eventType: event.eventType,
				category: "permission_event",
				source: "managed_control",
				content: event.content,
				isNoise: false,
				providerEventType: null,
				toolName: null,
				toolInput: null,
				toolResponse: null,
				rawPayload: {
					approval_id: event.approvalId,
					request_kind: event.requestKind,
					tool_use_id: approvalWaitId(event.approvalId),
				},
				createdAt: iso(nowMs),
				dedupKey: null,
				deletesIfStored: [],
			},
		],
		drops: {},
	};
	const stored = await persistEvents(sessionId, plan);
	notifySessionEvents(sessionId, stored);
}

async function broadcastSession(sessionId: string): Promise<void> {
	const session = await getSession(sessionId);
	if (session) notifySessionUpdated(session);
}

function logEffectFailure(kind: string, sessionId: string): void {
	console.error(JSON.stringify({ kind, level: "error", sessionId }));
}

/** The timeline line for a request opening: fixed words and counts, never anything the agent wrote. */
export function openedWords(
	opened: Pick<OpenedApproval, "requestKind" | "fileCount" | "agent" | "tool" | "fromSubagent">,
): string {
	const who =
		opened.fromSubagent === true ? "A subagent" : opened.agent === "claude" ? "Claude" : "Codex";
	if (opened.requestKind === "command") return `${who} asks to run a command`;
	if (opened.requestKind === "claude_tool") {
		// An MCP tool is worded without its names: they are the server's, and the timeline is shared.
		if (opened.tool === "mcp") return `${who} asks to use an MCP tool`;
		if (opened.tool === "Agent") return `${who} ${AGENT_OPENED_WORDS}`;
		return opened.tool === "Read" ? `${who} asks to read a file` : `${who} asks to fetch a URL`;
	}
	return `${who} asks to change ${opened.fileCount} ${opened.fileCount === 1 ? "file" : "files"}`;
}

/** A request opened: the timeline line (fixed words only), the wait, the dashboard refresh. */
export async function runApprovalOpenedEffects(
	opened: OpenedApproval,
	deps?: ApprovalDeps,
): Promise<void> {
	const content = openedWords(opened);
	try {
		await writeApprovalEvent(
			opened.sessionId,
			{
				eventType: "PermissionRequest",
				content,
				requestKind: opened.requestKind,
				approvalId: opened.approvalId,
			},
			clockOf(deps),
		);
	} catch {
		logEffectFailure("codex_approval_event_failed", opened.sessionId);
	}
	try {
		await applyApprovalWait(opened.sessionId, opened.approvalId, "open");
	} catch {
		waitRepair.add(opened.sessionId);
		logEffectFailure("codex_approval_wait_failed", opened.sessionId);
	}
	await broadcastSession(opened.sessionId).catch(() =>
		logEffectFailure("codex_approval_broadcast_failed", opened.sessionId),
	);
}

/** Rows closed: the wait cleared, the closing event (a fixed word), the dashboard refresh. */
export async function runApprovalClosedEffects(
	closed: readonly ClosedApproval[],
	deps?: ApprovalDeps,
): Promise<void> {
	const touched = new Set<string>();
	for (const item of closed) {
		touched.add(item.sessionId);
		try {
			await applyApprovalWait(item.sessionId, item.approvalId, "close");
		} catch {
			waitRepair.add(item.sessionId);
			logEffectFailure("codex_approval_wait_failed", item.sessionId);
		}
		try {
			await writeApprovalEvent(
				item.sessionId,
				{
					eventType: APPROVAL_RESOLVED_EVENT_TYPE,
					content: `Approval resolved: ${resolvedWord(item.reason, item.decision)}`,
					requestKind: item.requestKind,
					approvalId: item.approvalId,
				},
				clockOf(deps),
			);
		} catch {
			logEffectFailure("codex_approval_event_failed", item.sessionId);
		}
	}
	for (const sessionId of touched) {
		await broadcastSession(sessionId).catch(() =>
			logEffectFailure("codex_approval_broadcast_failed", sessionId),
		);
	}
}

// ── wire validation ─────────────────────────────────────────────────────────

const ID_MAX = 128;

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function optionalString(value: unknown, max: number): string | null | undefined {
	if (value === undefined || value === null) return value as null | undefined;
	return typeof value === "string" && value.length <= max ? value : undefined;
}

/**
 * Strict parse of a supervisor's approval report. Copies only the named fields
 * (an allowlist), so nothing the sender adds reaches the row. Text fields are
 * not capped here beyond the route's body limit: the presentation builder cuts
 * and flags them. Null for anything malformed or of an unknown `v`.
 */
export function parseApprovalReport(body: unknown): CodexApprovalReportRequest | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	if (b.v !== 1) return null;
	if (!isBoundedString(b.runtimeEpoch, ID_MAX) || !isBoundedString(b.rpcId, ID_MAX)) return null;
	if (!(APPROVAL_REQUEST_KINDS as readonly unknown[]).includes(b.requestKind)) return null;
	if (!isBoundedString(b.threadId, ID_MAX) || !isBoundedString(b.turnId, ID_MAX)) return null;
	if (!isBoundedString(b.itemId, ID_MAX)) return null;
	if (b.providerApprovalId !== null && !isBoundedString(b.providerApprovalId, ID_MAX)) return null;
	if (typeof b.ageMs !== "number") return null;
	// An int32 column: a larger number would fail the insert, and the failure would carry the row's text.
	if (
		typeof b.revision !== "number" ||
		!Number.isSafeInteger(b.revision) ||
		b.revision < 0 ||
		b.revision > CODEX_APPROVAL_LIMITS.revisionMax
	) {
		return null;
	}
	if (typeof b.truncated !== "boolean") return null;
	if (!Array.isArray(b.declineOnly) || b.declineOnly.length > NOT_APPROVABLE_REASONS.length) {
		return null;
	}
	const declineOnly: NotApprovableReason[] = [];
	for (const reason of b.declineOnly) {
		if (!(NOT_APPROVABLE_REASONS as readonly unknown[]).includes(reason)) return null;
		declineOnly.push(reason as NotApprovableReason);
	}
	const textLimit = CODEX_APPROVAL_LIMITS.reportBodyBytes;
	const command = optionalString(b.command, textLimit);
	const cwd = optionalString(b.cwd, textLimit);
	const reason = optionalString(b.reason, textLimit);
	const grantRoot = optionalString(b.grantRoot, textLimit);
	const tool = optionalString(b.tool, 64);
	const target = optionalString(b.target, textLimit);
	const blockedPath = optionalString(b.blockedPath, textLimit);
	if (
		(tool === undefined && b.tool !== undefined) ||
		(target === undefined && b.target !== undefined) ||
		(blockedPath === undefined && b.blockedPath !== undefined)
	) {
		return null;
	}
	const slots = parseClaudeToolReport(b);
	if (slots === null) return null;
	if (
		(command === undefined && b.command !== undefined) ||
		(cwd === undefined && b.cwd !== undefined) ||
		(reason === undefined && b.reason !== undefined) ||
		(grantRoot === undefined && b.grantRoot !== undefined)
	) {
		return null;
	}
	let changes: CodexApprovalReportRequest["changes"];
	if (b.changes !== undefined) {
		if (!Array.isArray(b.changes) || b.changes.length > 1000) return null;
		changes = [];
		for (const entry of b.changes) {
			if (entry === null || typeof entry !== "object") return null;
			const c = entry as Record<string, unknown>;
			if (typeof c.path !== "string" || typeof c.kind !== "string") return null;
			const movePath = optionalString(c.movePath, textLimit);
			const diff = optionalString(c.diff, textLimit);
			if (
				(movePath === undefined && c.movePath !== undefined) ||
				(diff === undefined && c.diff !== undefined)
			) {
				return null;
			}
			changes.push({ path: c.path, kind: c.kind, movePath, diff });
		}
	}
	return {
		v: 1,
		runtimeEpoch: b.runtimeEpoch,
		rpcId: b.rpcId,
		requestKind: b.requestKind as ApprovalRequestKind,
		threadId: b.threadId,
		turnId: b.turnId,
		itemId: b.itemId,
		providerApprovalId: b.providerApprovalId as string | null,
		ageMs: b.ageMs,
		revision: b.revision,
		command,
		cwd,
		reason,
		grantRoot,
		changes,
		truncated: b.truncated,
		declineOnly,
		...(tool !== undefined ? { tool } : {}),
		...(target !== undefined ? { target } : {}),
		...(blockedPath !== undefined ? { blockedPath } : {}),
		...slots,
	};
}

/** Strict parse of a sync body, within the live and resolved caps. Null for anything malformed. */
export function parseApprovalSync(body: unknown): CodexApprovalSyncRequest | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	if (b.v !== 1 || !Array.isArray(b.live) || !Array.isArray(b.resolved)) return null;
	if (b.live.length > CODEX_APPROVAL_LIMITS.liveMax) return null;
	if (b.resolved.length > CODEX_APPROVAL_LIMITS.resolvedMax) return null;
	const live: CodexApprovalSyncRequest["live"] = [];
	for (const entry of b.live) {
		if (entry === null || typeof entry !== "object") return null;
		const e = entry as Record<string, unknown>;
		if (!isBoundedString(e.approvalId, ID_MAX)) return null;
		if (typeof e.revision !== "number" || !Number.isSafeInteger(e.revision)) return null;
		live.push({ approvalId: e.approvalId, revision: e.revision });
	}
	const resolved: CodexApprovalResolved[] = [];
	for (const entry of b.resolved) {
		if (entry === null || typeof entry !== "object") return null;
		const e = entry as Record<string, unknown>;
		if (!isBoundedString(e.approvalId, ID_MAX)) return null;
		if (!(TRACKER_OUTCOMES as readonly unknown[]).includes(e.outcome)) return null;
		if (
			e.sentDecision !== null &&
			!(APPROVAL_DECISIONS as readonly unknown[]).includes(e.sentDecision)
		) {
			return null;
		}
		resolved.push({
			approvalId: e.approvalId,
			outcome: e.outcome as TrackerOutcome,
			sentDecision: e.sentDecision as ApprovalDecision | null,
		});
	}
	return { v: 1, live, resolved };
}

// ── recording a request ─────────────────────────────────────────────────────

function clampAgeMs(ageMs: unknown): number {
	if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return CODEX_APPROVAL_TTL_MS;
	return Math.min(CODEX_APPROVAL_TTL_MS, Math.max(0, ageMs));
}

export interface RecordedApproval {
	created: boolean;
	response: CodexApprovalReportResponse;
}

function reportResponse(row: ApprovalRow, nowMs: number): CodexApprovalReportResponse {
	return {
		v: 1,
		approvalId: row.id,
		revision: row.presentationRevision,
		expiresInMs: Math.max(0, parseMs(row.expiresAt) - nowMs),
	};
}

/**
 * The write path failed for a reason that is not a refusal. A fixed message and no
 * cause: the driver's error (and drizzle's `Failed query ... params: ...` wrapper)
 * carries the bound parameters, which here are the agent's command or diff, and
 * the framework's default handler prints the whole error chain.
 */
export class ApprovalWriteError extends Error {
	constructor() {
		super("codex_approval_write_failed");
		this.name = "ApprovalWriteError";
	}
}

const DRIVER_CODE_RE = /^[A-Za-z0-9_]{1,40}$/;

function logWriteFailure(sessionId: string, error: unknown): void {
	const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
	console.error(
		JSON.stringify({
			kind: "codex_approval_write_failed",
			level: "error",
			sessionId,
			...(typeof code === "string" && DRIVER_CODE_RE.test(code) ? { driverCode: code } : {}),
		}),
	);
}

/** The fields that say which request a row is. A report for an existing key must agree on all of them. */
function sameIdentity(row: ApprovalRow, report: CodexApprovalReportRequest): boolean {
	return (
		row.requestKind === report.requestKind &&
		row.threadId === report.threadId &&
		row.turnId === report.turnId &&
		row.itemId === report.itemId &&
		(row.providerApprovalId ?? null) === (report.providerApprovalId ?? null)
	);
}

/**
 * A supervisor reports an approval request. The caller has already established
 * that `supervisorId` owns `sessionId` (assertSupervisorCanWriteSession); this
 * function checks it again on its own transaction (the owner of record can change
 * between the two) and takes the id to count the host's open rows.
 *
 * A request already recorded (same session, runtime epoch and RPC id) is
 * updated only while it is pending and only for a higher revision; `expires_at`
 * never moves. If it names a different request (kind, thread, turn, item or
 * provider id), the report is refused `identity_conflict` and the old row is
 * closed, so the new request can never inherit the old one's text or answer.
 * Refused while a Stop is queued or running. Limits: 32 open per session, 60
 * created per 10 minutes per session, 64 open per owner host.
 */
export async function recordApprovalRequest(
	supervisorId: string,
	sessionId: string,
	report: CodexApprovalReportRequest,
	deps?: ApprovalDeps,
): Promise<RecordedApproval> {
	const nowMs = clockOf(deps);
	let built!: BuiltPresentation;
	let agent: PresentationAgent = "codex";
	const expiresAtMs = nowMs + CODEX_APPROVAL_TTL_MS - clampAgeMs(report.ageMs);
	const sink: { opened: OpenedApproval | null; closed: ClosedApproval[]; conflict: boolean } = {
		opened: null,
		closed: [],
		conflict: false,
	};

	let result: RecordedApproval;
	try {
		result = await withTransaction(async (tx): Promise<RecordedApproval> => {
			const [session] = await tx
				.select({
					sessionId: sessions.sessionId,
					launchAgentType: launchRequests.agentType,
					metadata: sessions.metadata,
				})
				.from(sessions)
				.leftJoin(launchRequests, eq(launchRequests.launchCorrelationId, sessions.sessionId))
				.where(eq(sessions.sessionId, sessionId))
				.limit(1);
			if (!session) throw new ApprovalRefusal("session_unknown");
			if ((await resolveSessionOwner(tx, sessionId)) !== supervisorId) {
				throw new ApprovalRefusal("session_not_owned");
			}
			// By the launch's agent type, never the session row's: a hook can create a row under a launch's id and choose its type (AGEN-91).
			agent = session.launchAgentType === "claude_code" ? "claude" : "codex";
			// A Claude-only kind from a session that isn't Claude's is a malformed report, not a card.
			if (report.requestKind === "claude_tool" && agent !== "claude") {
				throw new ApprovalRefusal("invalid_body");
			}
			// So is a subagent's mark or a helper card: only a Claude fork has subagents.
			if ((report.fromSubagent !== undefined || report.agent !== undefined) && agent !== "claude") {
				throw new ApprovalRefusal("invalid_body");
			}
			// The servers the fork was started with are the only ones an MCP tool call may name (AGEN-121).
			const applied = parseAppliedForkOptions(
				(session.metadata as { forkOptions?: unknown } | null)?.forkOptions,
			);
			if (!mcpReportServerApplied(report, applied)) throw new ApprovalRefusal("invalid_body");
			built = buildPresentation(report, agent, {
				mcpServers: applied?.mcpServers.map((s) => s.name),
			});
			if (await sessionHasActiveStop(tx, sessionId)) throw new ApprovalRefusal("session_stopping");
			// A request on a turn a person has already stopped: the host declines that one request.
			if (await turnHasActiveInterrupt(tx, sessionId, report.turnId)) {
				throw new ApprovalRefusal("turn_interrupted");
			}

			const sameRequest = and(
				eq(codexApprovals.sessionId, sessionId),
				eq(codexApprovals.runtimeEpoch, report.runtimeEpoch),
				eq(codexApprovals.rpcId, report.rpcId),
			);
			const reReport = async (existing: ApprovalRow): Promise<RecordedApproval> => {
				if (!sameIdentity(existing, report)) {
					// The same key now names another request. Close the old row (committed with this
					// transaction) and refuse after the commit; never update it from this report.
					const closed = await closeApproval(
						tx,
						existing.id,
						issuedAccept(existing) ? "outcome_unknown" : "runtime_gone",
						nowMs,
					);
					if (closed) sink.closed.push(closed);
					sink.conflict = true;
					return { created: false, response: reportResponse(existing, nowMs) };
				}
				if (existing.status !== "pending" || report.revision <= existing.presentationRevision) {
					return { created: false, response: reportResponse(existing, nowMs) };
				}
				const updated = await tx
					.update(codexApprovals)
					.set({
						presentation: built.presentationJson,
						reasonText: built.reasonText,
						presentationHash: built.hash,
						presentationRevision: report.revision,
						approvable: built.approvable,
						notApprovableReason: built.notApprovableReason,
						updatedAt: iso(nowMs),
					})
					.where(
						and(
							eq(codexApprovals.id, existing.id),
							eq(codexApprovals.status, "pending"),
							lt(codexApprovals.presentationRevision, report.revision),
						),
					)
					.returning();
				return { created: false, response: reportResponse(updated[0] ?? existing, nowMs) };
			};

			const [existing] = await tx.select().from(codexApprovals).where(sameRequest).limit(1);
			if (existing) return reReport(existing);

			await assertWithinLimits(tx, supervisorId, sessionId, nowMs);

			const inserted = await tx
				.insert(codexApprovals)
				.values({
					sessionId,
					runtimeEpoch: report.runtimeEpoch,
					rpcId: report.rpcId,
					requestKind: report.requestKind,
					threadId: report.threadId,
					turnId: report.turnId,
					itemId: report.itemId,
					providerApprovalId: report.providerApprovalId,
					presentation: built.presentationJson,
					reasonText: built.reasonText,
					presentationHash: built.hash,
					presentationRevision: report.revision,
					approvable: built.approvable,
					notApprovableReason: built.notApprovableReason,
					// Measured (S8): cancel is honoured for a command and for a file change alike.
					canCancel: true,
					status: "pending",
					createdAt: iso(nowMs),
					expiresAt: iso(expiresAtMs),
					updatedAt: iso(nowMs),
				})
				.onConflictDoNothing()
				.returning();
			if (inserted.length === 0) {
				// Lost a creation race to the same key: the winner's row is the row.
				const [winner] = await tx.select().from(codexApprovals).where(sameRequest).limit(1);
				if (!winner) throw new ApprovalRefusal("session_unknown");
				return reReport(winner);
			}
			const row = inserted[0] as ApprovalRow;
			sink.opened = {
				approvalId: row.id,
				sessionId,
				requestKind: report.requestKind,
				fileCount:
					built.presentation.requestKind === "file_change" ? built.presentation.changes.length : 0,
				agent,
				tool: built.presentation.requestKind === "claude_tool" ? built.presentation.tool : null,
				...(built.presentation.fromSubagent === true ? { fromSubagent: true } : {}),
			};
			return { created: true, response: reportResponse(row, nowMs) };
		});
	} catch (error) {
		if (error instanceof ApprovalRefusal) throw error;
		logWriteFailure(sessionId, error);
		throw new ApprovalWriteError();
	}

	if (sink.closed.length > 0) await runApprovalClosedEffects(sink.closed, deps);
	if (sink.conflict) throw new ApprovalRefusal("identity_conflict");
	if (sink.opened) await runApprovalOpenedEffects(sink.opened, deps);
	return result;
}

async function assertWithinLimits(
	tx: Tx,
	supervisorId: string,
	sessionId: string,
	nowMs: number,
): Promise<void> {
	const [perSession] = await tx
		.select({ n: sql<number>`count(*)` })
		.from(codexApprovals)
		.where(
			and(
				eq(codexApprovals.sessionId, sessionId),
				inArray(codexApprovals.status, [...OPEN_STATUSES]),
			),
		);
	if (Number(perSession?.n ?? 0) >= CODEX_APPROVAL_LIMITS.openPerSession) {
		throw new ApprovalRefusal("too_many_pending");
	}
	const since = iso(nowMs - CODEX_APPROVAL_LIMITS.createdWindowMs);
	const [recent] = await tx
		.select({ n: sql<number>`count(*)` })
		.from(codexApprovals)
		.where(and(eq(codexApprovals.sessionId, sessionId), gte(codexApprovals.createdAt, since)));
	if (Number(recent?.n ?? 0) >= CODEX_APPROVAL_LIMITS.createdPer10MinPerSession) {
		throw new ApprovalRefusal("too_many_pending");
	}
	const [perHost] = await tx
		.select({ n: sql<number>`count(*)` })
		.from(codexApprovals)
		.innerJoin(managedSessions, eq(managedSessions.sessionId, codexApprovals.sessionId))
		.leftJoin(launchRequests, ownerLaunchJoin)
		.where(and(sessionOwnedBy(supervisorId), inArray(codexApprovals.status, [...OPEN_STATUSES])));
	if (Number(perHost?.n ?? 0) >= CODEX_APPROVAL_LIMITS.openPerHost) {
		throw new ApprovalRefusal("too_many_pending");
	}
}

// ── re-judging a stored answer ──────────────────────────────────────────────

/**
 * Before an accept is first issued to the host: is the person who clicked still
 * allowed to? They must exist, not be disabled, and pass the owner rule as it
 * stands now. A row answered with no user (only under DISABLE_AUTH, where every
 * caller counts as a person) passes. Reads on the issuing transaction.
 */
export async function rejudgeStoredAnswer(
	row: Pick<ApprovalRow, "sessionId" | "answeredByUserId" | "decision">,
	tx: Tx,
): Promise<boolean> {
	if (row.answeredByUserId === null) return true;
	const [user] = await tx
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, row.answeredByUserId))
		.limit(1);
	if (!user || user.disabledAt) return false;
	const [session] = await tx
		.select({ ownerUserId: sessions.ownerUserId, storedMode: storedModeColumn })
		.from(sessions)
		.where(eq(sessions.sessionId, row.sessionId))
		.limit(1);
	const mode = modeFromStoredColumn(session?.storedMode);
	const actor: Actor = {
		userId: row.answeredByUserId,
		label: "user",
		role: user.role === "admin" ? "admin" : "member",
		mode,
	};
	return mayAnswerApproval(
		actor,
		mode,
		session ? { ownerUserId: session.ownerUserId ?? null } : null,
		(row.decision as ApprovalDecision | null) ?? "accept",
	);
}

// ── answering ───────────────────────────────────────────────────────────────

/** Who is asking: the actor, the key they came with, and whether a signed-in person is behind the request. */
export interface ApprovalCaller {
	actor: Actor;
	keyId: string | null;
	/** True for a signed-in person (or the DISABLE_AUTH operator); never for an API key. Required to accept. */
	isHuman: boolean;
}

async function hostOf(tx: Tx, sessionId: string, nowMs: number): Promise<CodexApprovalHost> {
	const states = await getSessionOwnerHostStates([sessionId], nowMs, tx);
	const state = states.get(sessionId)?.state ?? "gone";
	const [managed] = await tx
		.select({ hostName: managedSessions.hostName })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	return { state, name: managed?.hostName ?? null };
}

function isDecision(value: unknown): value is ApprovalDecision {
	return (APPROVAL_DECISIONS as readonly unknown[]).includes(value);
}

/** The refusal for a row that can't be answered as it stands. */
function refusalForRow(effective: EffectiveApproval): ApprovalRefusal | null {
	if (effective.state === "closed") {
		if (effective.closedReason === "session_stopped") return new ApprovalRefusal("session_stopped");
		if (effective.closedReason === "turn_stopped") return new ApprovalRefusal("turn_interrupted");
		if (effective.closedReason === "expired") return new ApprovalRefusal("expired");
		return new ApprovalRefusal("already_resolved");
	}
	if (effective.state === "answered") return new ApprovalRefusal("already_resolved");
	return null;
}

/**
 * An accept of an MCP tool or Agent card on a fork that runs the host owner's MCP servers or subagents: in team
 * mode only that owner (review H1). Declines and every other card are not touched.
 */
async function refuseForkOptionCardUnlessConsenter(
	tx: Tx,
	caller: ApprovalCaller,
	sessionId: string,
	row: ApprovalRow,
): Promise<void> {
	if (row.requestKind !== "claude_tool" || row.presentation === null) return;
	let isOptionCard = false;
	try {
		const parsed = JSON.parse(row.presentation) as { mcp?: unknown; agent?: unknown };
		isOptionCard = parsed.mcp !== undefined || parsed.agent !== undefined;
	} catch {
		return;
	}
	if (!isOptionCard) return;
	const [session] = await tx
		.select({ metadata: sessions.metadata, storedMode: storedModeColumn })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return;
	const mode = caller.actor.mode ?? modeFromStoredColumn(session.storedMode);
	if (mayDriveForkOptions(caller.actor, mode, session.metadata) !== null) {
		throw new ApprovalRefusal("fork_options_host_not_yours");
	}
}

/**
 * A person answers a pending approval. Order, with every step a fixed code:
 * decision in the fixed set; the owner rule BEFORE the row is read (so a
 * refusal says nothing about the row); an accept needs a signed-in person; the
 * row; its effective state; an accept needs the hash of what was shown and an
 * approvable row; the host is live; then one guarded UPDATE
 * (`status = 'pending' AND expires_at > now AND no Stop active`, plus the hash
 * for an accept) and the audit insert, in one transaction. Answered at most
 * once; `decision` never changes.
 */
export async function answerApproval(
	sessionId: string,
	approvalId: string,
	input: { decision: unknown; presentationHash?: unknown },
	caller: ApprovalCaller,
	deps?: ApprovalDeps,
): Promise<CodexApprovalDecisionResponse> {
	const nowMs = clockOf(deps);
	if (!isDecision(input.decision)) throw new ApprovalRefusal("invalid_decision");
	const decision = input.decision;

	try {
		await assertCanAnswerApproval(caller.actor, sessionId, decision);
	} catch (error) {
		if (error instanceof NotOwnerError) throw new ApprovalRefusal("not_owner");
		throw error;
	}
	if (decision === "accept" && !caller.isHuman) throw new ApprovalRefusal("human_required");

	const db = getDb();
	const [row] = await db
		.select()
		.from(codexApprovals)
		.where(and(eq(codexApprovals.id, approvalId), eq(codexApprovals.sessionId, sessionId)))
		.limit(1);
	if (!row) throw new ApprovalRefusal("approval_not_found");

	const effective = deriveApprovalOutcome(row, nowMs);
	const stateRefusal = refusalForRow(effective);
	if (stateRefusal) throw stateRefusal;

	let hash: string | null = null;
	if (decision === "accept") {
		if (typeof input.presentationHash !== "string" || input.presentationHash === "") {
			throw new ApprovalRefusal("presentation_hash_required");
		}
		hash = input.presentationHash;
		if (!row.approvable) throw new ApprovalRefusal("not_approvable");
		await refuseForkOptionCardUnlessConsenter(db, caller, sessionId, row);
	}
	if (decision === "cancel" && !row.canCancel) throw new ApprovalRefusal("invalid_decision");

	const host = await hostOf(db, sessionId, nowMs);
	if (host.state === "offline") throw new ApprovalRefusal("host_offline");
	if (host.state === "gone") throw new ApprovalRefusal("host_gone");

	await deps?.afterRead?.("answer");

	let answeredAtMs = nowMs;
	const answered = await withTransaction(async (tx): Promise<ApprovalRow | null> => {
		// Read again at the write: the checks above took time, and the transaction may have queued.
		// The expiry the guard enforces is the expiry at the moment the row is changed.
		answeredAtMs = clockOf(deps);
		const at = iso(answeredAtMs);
		const conditions = [
			eq(codexApprovals.id, approvalId),
			eq(codexApprovals.sessionId, sessionId),
			eq(codexApprovals.status, "pending"),
			gt(codexApprovals.expiresAt, at),
			notExists(stopActiveFor(tx)),
			notExists(interruptActiveFor(tx)),
		];
		if (decision === "accept" && hash !== null) {
			conditions.push(
				eq(codexApprovals.presentationHash, hash),
				eq(codexApprovals.approvable, true),
			);
		}
		if (decision === "cancel") conditions.push(eq(codexApprovals.canCancel, true));
		const updated = await tx
			.update(codexApprovals)
			.set({
				status: "answered",
				decision,
				answeredByUserId: caller.actor.userId,
				answeredByKeyId: caller.keyId,
				answeredAt: at,
				updatedAt: at,
			})
			.where(and(...conditions))
			.returning();
		if (updated.length === 0) return null;
		const winner = updated[0] as ApprovalRow;
		await tx.insert(codexApprovalAudit).values({
			approvalId,
			sessionId,
			hostName: host.name,
			actorUserId: caller.actor.userId,
			actorKeyId: caller.keyId,
			actorLabel: caller.actor.label,
			requestKind: winner.requestKind,
			revision: winner.presentationRevision,
			presentationHash: winner.presentationHash,
			decision,
			outcome: "pending",
			createdAt: at,
		});
		return winner;
	});

	if (!answered) throw await refusalAfterLostRace(approvalId, sessionId, hash, answeredAtMs);

	logAdminAction("codex_approval_answered", caller.actor, {
		approvalId,
		sessionId,
		decision,
		requestKind: answered.requestKind,
		revision: answered.presentationRevision,
	});
	return { v: 1, approval: toSummary(answered, nowMs, true) };
}

/** The guarded answer matched nothing: say why, from the row as it is now. */
async function refusalAfterLostRace(
	approvalId: string,
	sessionId: string,
	hash: string | null,
	nowMs: number,
): Promise<ApprovalRefusal> {
	const db = getDb();
	const [row] = await db
		.select()
		.from(codexApprovals)
		.where(and(eq(codexApprovals.id, approvalId), eq(codexApprovals.sessionId, sessionId)))
		.limit(1);
	if (!row) return new ApprovalRefusal("approval_not_found");
	const stateRefusal = refusalForRow(deriveApprovalOutcome(row, nowMs));
	if (stateRefusal) return stateRefusal;
	if (await sessionHasActiveStop(db, sessionId)) return new ApprovalRefusal("session_stopped");
	if (await turnHasActiveInterrupt(db, sessionId, row.turnId)) {
		return new ApprovalRefusal("turn_interrupted");
	}
	if (hash !== null && row.presentationHash !== hash)
		return new ApprovalRefusal("presentation_changed");
	if (hash !== null && !row.approvable) return new ApprovalRefusal("not_approvable");
	return new ApprovalRefusal("already_resolved");
}

// ── reading ─────────────────────────────────────────────────────────────────

function parsePresentation(row: ApprovalRow): CodexApprovalPresentation | null {
	if (row.presentation === null) return null;
	try {
		return JSON.parse(row.presentation) as CodexApprovalPresentation;
	} catch {
		return null;
	}
}

function toSummary(row: ApprovalRow, nowMs: number, withPreview: boolean): CodexApprovalSummary {
	const effective = deriveApprovalOutcome(row, nowMs);
	const open = effective.state !== "closed";
	const presentation = open && withPreview ? parsePresentation(row) : null;
	return {
		id: row.id,
		requestKind: row.requestKind as ApprovalRequestKind,
		state: effective.state,
		outcome: effective.outcome,
		decision: (row.decision as ApprovalDecision | null) ?? null,
		answeredAt: row.answeredAt,
		revision: row.presentationRevision,
		presentationHash: row.presentationHash,
		approvable: row.approvable && effective.state === "pending",
		notApprovableReason: (row.notApprovableReason as NotApprovableReason | null) ?? null,
		canCancel: row.canCancel,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		expiresInSeconds: open ? Math.max(0, Math.ceil((parseMs(row.expiresAt) - nowMs) / 1000)) : 0,
		preview: presentation ? buildPreview(presentation) : null,
	};
}

async function readAccess(
	caller: ApprovalCaller,
	sessionId: string,
): Promise<{
	mode: InstanceModeName;
	ownerUserId: string | null | undefined;
	agentType: string | null;
}> {
	const db = getDb();
	const [session] = await db
		.select({
			ownerUserId: sessions.ownerUserId,
			agentType: sessions.agentType,
			storedMode: storedModeColumn,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const mode = caller.actor.mode ?? modeFromStoredColumn(session?.storedMode);
	// A session that isn't there has no owner field at all, which only an admin reads.
	const ownerUserId = session ? (session.ownerUserId ?? null) : undefined;
	if (!canReadSession({ ...caller.actor, mode }, { ownerUserId })) {
		throw new ApprovalRefusal("not_owner");
	}
	return { mode, ownerUserId, agentType: session?.agentType ?? null };
}

/**
 * The approvals on a session a person can see: the open ones, then those closed
 * in the last five minutes and any that may have run, in creation order, at
 * most 52. A caller who can't read the session gets `not_owner`, which the card
 * treats as a state of its own.
 */
export async function listApprovalsForSession(
	sessionId: string,
	caller: ApprovalCaller,
	deps?: ApprovalDeps,
): Promise<CodexApprovalList> {
	const nowMs = clockOf(deps);
	const { mode, ownerUserId } = await readAccess(caller, sessionId);
	const db = getDb();
	const visibleSince = iso(nowMs - CODEX_CLOSED_VISIBLE_MS);
	const elsewhereSince = iso(nowMs - CODEX_DECIDED_ELSEWHERE_VISIBLE_MS);
	const rows: ApprovalRow[] = await db
		.select()
		.from(codexApprovals)
		.where(
			and(
				eq(codexApprovals.sessionId, sessionId),
				or(
					inArray(codexApprovals.status, [...OPEN_STATUSES]),
					and(
						eq(codexApprovals.status, "closed"),
						or(
							gte(codexApprovals.closedAt, visibleSince),
							eq(codexApprovals.closedReason, "outcome_unknown"),
							and(
								eq(codexApprovals.closedReason, "decided_elsewhere"),
								gte(codexApprovals.closedAt, elsewhereSince),
							),
						),
					),
				),
			),
		)
		.orderBy(
			sql`case when ${codexApprovals.status} = 'closed' then 1 else 0 end`,
			// Open rows keep creation order. Closed rows: the newest close first, so the 52 that
			// fit are the ones a person has just seen change (this key is null on open rows).
			desc(codexApprovals.closedAt),
			asc(codexApprovals.createdAt),
			asc(codexApprovals.id),
		)
		.limit(CODEX_APPROVAL_LIMITS.listMax);
	const host = await hostOf(db, sessionId, nowMs);
	const canAccept =
		caller.isHuman &&
		mayAnswerApproval(
			{ ...caller.actor, mode },
			mode,
			ownerUserId === undefined ? null : { ownerUserId },
			"accept",
		);
	// Explicitly the owner's or an admin's (solo: the one person), not merely someone who may read the session:
	// an unowned session in team mode is readable by any member, and a stranger's message may hold anything.
	const mayReadPeerTurn =
		mode === "solo" ||
		caller.actor.role === "admin" ||
		(typeof ownerUserId === "string" && caller.actor.userId === ownerUserId);
	const peerTurn = mayReadPeerTurn ? await peerTurnOf(db, sessionId) : null;
	return {
		v: 1,
		approvals: rows.map((row) => toSummary(row, nowMs, true)),
		host,
		viewer: { canAccept },
		...(peerTurn ? { peerTurn } : {}),
	};
}

/**
 * What a takeover fork was stopped for, if it was: the server-owned `metadata.peerTurn`. Only this read
 * returns it, and only to the owner or an admin (judged by the caller above); the session DTO strips it. It is
 * the last message found in the transcript, which may not be the one that stopped the session.
 */
async function peerTurnOf(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle
	db: any,
	sessionId: string,
): Promise<ClaudePeerTurnNotice | null> {
	const [row] = await db
		.select({ metadata: sessions.metadata })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const peer = (row?.metadata as Record<string, unknown> | null | undefined)?.peerTurn;
	if (!peer || typeof peer !== "object") return null;
	const { text, hidden } = peer as { text?: unknown; hidden?: unknown };
	return {
		text: typeof text === "string" ? text : null,
		hidden: hidden === true,
	};
}

/** One approval with the full text a person reviews before approving. Fetched once per id and revision. */
export async function getApprovalDetail(
	sessionId: string,
	approvalId: string,
	caller: ApprovalCaller,
	deps?: ApprovalDeps,
): Promise<CodexApprovalDetail> {
	const nowMs = clockOf(deps);
	const { agentType } = await readAccess(caller, sessionId);
	const [row] = await getDb()
		.select()
		.from(codexApprovals)
		.where(and(eq(codexApprovals.id, approvalId), eq(codexApprovals.sessionId, sessionId)))
		.limit(1);
	if (!row) throw new ApprovalRefusal("approval_not_found");
	const approval = toSummary(row, nowMs, true);
	const open = approval.state !== "closed";
	const presentation = open ? parsePresentation(row) : null;
	return {
		v: 1,
		approval,
		presentation,
		// Beside the presentation (so outside the hash), for a Claude session only.
		...(presentation && agentType === "claude_code"
			? { touchesAgentConfig: touchesAgentConfig(presentation) }
			: {}),
		reasonText: open ? row.reasonText : null,
	};
}

// ── closing rows in bulk ────────────────────────────────────────────────────

async function closeAll(
	tx: Tx,
	rows: readonly Pick<ApprovalRow, "id" | "decision" | "firstDeliveredAt">[],
	reasonFor: (row: Pick<ApprovalRow, "decision" | "firstDeliveredAt">) => ApprovalClosedReason,
	nowMs: number,
): Promise<ClosedApproval[]> {
	const closed: ClosedApproval[] = [];
	for (const row of rows) {
		const result = await closeApproval(tx, row.id, reasonFor(row), nowMs);
		if (result) closed.push(result);
	}
	return closed;
}

const OPEN_ROW_COLUMNS = {
	id: codexApprovals.id,
	decision: codexApprovals.decision,
	firstDeliveredAt: codexApprovals.firstDeliveredAt,
};

/**
 * The managed session reported a live terminal state (the caller applies the
 * rule: completed or failed, or stopped/completed/failed; never `degraded`, and
 * never a replayed report, which can be older than the rows). Every open row
 * closes `session_stopped`, or `outcome_unknown` where an accept had already
 * been issued.
 */
export async function closeApprovalsForSession(
	sessionId: string,
	deps?: ApprovalDeps,
): Promise<ClosedApproval[]> {
	const nowMs = clockOf(deps);
	const closed = await withTransaction(async (tx) => {
		const rows = await tx
			.select(OPEN_ROW_COLUMNS)
			.from(codexApprovals)
			.where(
				and(
					eq(codexApprovals.sessionId, sessionId),
					inArray(codexApprovals.status, [...OPEN_STATUSES]),
				),
			);
		return closeAll(
			tx,
			rows,
			(row) => (issuedAccept(row) ? "outcome_unknown" : "session_stopped"),
			nowMs,
		);
	});
	await runApprovalClosedEffects(closed, deps);
	return closed;
}

/**
 * A supervisor registered again: its previous process (and the app-servers it
 * ran) is gone. Every open row on a session it owns closes `runtime_gone`, or
 * `outcome_unknown` where an accept had been issued. The rows are found through
 * the owner-of-record rule, never from anything the host sent.
 */
export async function closeApprovalsForRestartedHost(
	supervisorId: string,
	deps?: ApprovalDeps,
): Promise<ClosedApproval[]> {
	const nowMs = clockOf(deps);
	const closed = await withTransaction(async (tx) => {
		const rows = await tx
			.select(OPEN_ROW_COLUMNS)
			.from(codexApprovals)
			.innerJoin(managedSessions, eq(managedSessions.sessionId, codexApprovals.sessionId))
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(and(sessionOwnedBy(supervisorId), inArray(codexApprovals.status, [...OPEN_STATUSES])));
		return closeAll(
			tx,
			rows,
			(row) => (issuedAccept(row) ? "outcome_unknown" : "runtime_gone"),
			nowMs,
		);
	});
	await runApprovalClosedEffects(closed, deps);
	return closed;
}

function issuedAccept(row: { decision: string | null; firstDeliveredAt: string | null }): boolean {
	return row.decision === "accept" && row.firstDeliveredAt !== null;
}

// ── the host's sync ─────────────────────────────────────────────────────────

/**
 * The sync's one read: rows the authenticated host owns (through the owner-of-record
 * rule) that are open, or that its sync names. Driven from `codex_approvals` by its
 * `(status, expires_at)` index, then primary-key joins; exported so the plan test
 * explains the very statement the sync runs.
 */
export function ownedApprovalRowsQuery(tx: Tx, supervisorId: string, listed: readonly string[]) {
	const open = inArray(codexApprovals.status, [...OPEN_STATUSES]);
	return tx
		.select({ approval: codexApprovals })
		.from(codexApprovals)
		.innerJoin(managedSessions, eq(managedSessions.sessionId, codexApprovals.sessionId))
		.leftJoin(launchRequests, ownerLaunchJoin)
		.where(
			and(
				sessionOwnedBy(supervisorId),
				listed.length > 0 ? or(open, inArray(codexApprovals.id, [...listed])) : open,
			),
		);
}

async function readOwnedRows(
	tx: Tx,
	supervisorId: string,
	listed: readonly string[],
): Promise<ApprovalRow[]> {
	const rows = await ownedApprovalRowsQuery(tx, supervisorId, listed);
	return rows.map((r: { approval: ApprovalRow }) => r.approval);
}

function logMismatch(row: ApprovalRow, resolved: CodexApprovalResolved): void {
	console.warn(
		JSON.stringify({
			kind: "codex_approval_outcome_mismatch",
			level: "warn",
			approvalId: row.id,
			outcome: resolved.outcome,
			sentDecision: resolved.sentDecision,
			rowStatus: row.status,
			rowDecision: row.decision,
		}),
	);
}

const DECLINED_IN_PLACE_OF_ACCEPT: ReadonlySet<TrackerOutcome> = new Set([
	"declined_slow_response",
	"declined_revision_changed",
	"declined_local",
]);

/** What a pending row (nobody answered it) closes as when the host reports its own terminal outcome. */
function reasonForUnansweredRow(outcome: TrackerOutcome): ApprovalClosedReason {
	switch (outcome) {
		case "resolved_before_response":
			return "interrupted";
		case "decided_elsewhere":
			return "decided_elsewhere";
		case "runtime_gone":
		case "runtime_gone_after_response":
			return "runtime_gone";
		default:
			return "expired";
	}
}

/**
 * Applies one outcome the host reports, per the D17 table
 * (shared/codex-approvals.ts TRACKER_OUTCOME_TABLE). Never changes a closed row.
 * Returns what closed, or null.
 */
async function applyReportedOutcome(
	tx: Tx,
	row: ApprovalRow,
	resolved: CodexApprovalResolved,
	nowMs: number,
): Promise<ClosedApproval | null> {
	const { outcome, sentDecision } = resolved;
	if (row.status === "closed") {
		if (row.closedReason === "outcome_unknown" && outcome === "resolved_after_response") {
			console.warn(
				JSON.stringify({ kind: "codex_approval_late_resolved", level: "warn", approvalId: row.id }),
			);
		}
		return null;
	}

	// A report that claims an accept was sent for a row no accept was answered on.
	if (sentDecision === "accept" && (row.decision !== "accept" || row.status === "pending")) {
		logMismatch(row, resolved);
		return closeApproval(tx, row.id, "outcome_unknown", nowMs, { hostOutcome: outcome });
	}

	const entry = TRACKER_OUTCOME_TABLE[outcome];
	if (!entry.terminal) {
		await tx
			.update(codexApprovals)
			.set({ hostOutcome: outcome, updatedAt: iso(nowMs) })
			.where(and(eq(codexApprovals.id, row.id), ne(codexApprovals.status, "closed")));
		return null;
	}

	let reason: ApprovalClosedReason | null;
	if (row.status === "pending") {
		reason = reasonForUnansweredRow(outcome);
	} else {
		// The row is answered. For the outcomes that mean "declined in place of an accept"
		// the row's own decision picks the column; otherwise the decision that was sent does.
		const acceptColumn = DECLINED_IN_PLACE_OF_ACCEPT.has(outcome)
			? row.decision === "accept"
			: sentDecision === "accept" || (sentDecision === null && row.decision === "accept");
		reason = acceptColumn ? entry.accept : entry.other;
	}
	if (reason === null) return null;
	return closeApproval(tx, row.id, reason, nowMs, { hostOutcome: outcome });
}

/**
 * Hands one answered row to the host, or says why not. Issuing is the
 * linearization point against Stop: one guarded UPDATE that requires the row
 * still answered, not fenced, within the accept's delivery window, and no Stop
 * queued or running. A row that doesn't match is closed (never issued) or handed
 * a decline, never an accept.
 */
async function issueOrRefuse(
	tx: Tx,
	row: ApprovalRow,
	nowMs: number,
	out: { answers: CodexApprovalAnswer[]; closedIds: string[]; closed: ClosedApproval[] },
	liveRevision: number | undefined,
	deps?: ApprovalDeps,
): Promise<void> {
	const decision = row.decision as ApprovalDecision;
	const decline = (): void => {
		out.answers.push({
			approvalId: row.id,
			decision: "decline",
			revision: row.presentationRevision,
		});
	};
	const closeNow = async (reason: ApprovalClosedReason): Promise<void> => {
		const closed = await closeApproval(tx, row.id, reason, nowMs);
		if (closed) out.closed.push(closed);
		out.closedIds.push(row.id);
	};

	if (row.fencedAt !== null) return decline();

	if (decision === "accept") {
		// The person approved the text at this revision; the host must be holding that same
		// revision. A host that hasn't listed the request yet (inside the new-row grace) gets
		// nothing this poll; one holding another revision is declined, and the row, which no
		// accept reached, is closed.
		if (liveRevision === undefined) return;
		if (liveRevision !== row.presentationRevision) {
			if (row.firstDeliveredAt === null) await closeNow("revision_changed");
			return decline();
		}
	}

	if (decision === "accept" && row.firstDeliveredAt === null) {
		if (!(await rejudgeStoredAnswer(row, tx))) return closeNow("answer_withdrawn");
	}

	await deps?.afterRead?.("issue");

	// The time at the write, not at the start of the poll: the window is enforced as of now.
	const writeMs = clockOf(deps);
	const at = iso(writeMs);
	const cutoff = iso(writeMs - CODEX_ACCEPT_DELIVERY_WINDOW_MS);
	const issued = await tx
		.update(codexApprovals)
		.set({
			firstDeliveredAt: sql`coalesce(${codexApprovals.firstDeliveredAt}, ${at})`,
			lastIssuedAt: at,
			updatedAt: at,
		})
		.where(
			and(
				eq(codexApprovals.id, row.id),
				eq(codexApprovals.status, "answered"),
				isNull(codexApprovals.fencedAt),
				or(ne(codexApprovals.decision, "accept"), gte(codexApprovals.answeredAt, cutoff)),
				notExists(stopActiveFor(tx)),
				notExists(interruptActiveFor(tx)),
			),
		)
		.returning({ id: codexApprovals.id });
	if (issued.length > 0) {
		out.answers.push({ approvalId: row.id, decision, revision: row.presentationRevision });
		return;
	}

	// Not issued. Why, from the row as it is now.
	const [now] = await tx
		.select()
		.from(codexApprovals)
		.where(eq(codexApprovals.id, row.id))
		.limit(1);
	if (!now || now.status === "closed") {
		out.closedIds.push(row.id);
		return;
	}
	if (now.fencedAt !== null) return decline();
	const stopped = await sessionHasActiveStop(tx, row.sessionId);
	const undelivered = now.firstDeliveredAt === null;
	if (stopped) {
		if (undelivered) return closeNow("session_stopped");
		await tx
			.update(codexApprovals)
			.set({ fencedAt: at, updatedAt: at })
			.where(
				and(
					eq(codexApprovals.id, row.id),
					eq(codexApprovals.status, "answered"),
					isNull(codexApprovals.fencedAt),
				),
			);
		return decline();
	}
	if (await turnHasActiveInterrupt(tx, row.sessionId, row.turnId)) {
		// The turn was stopped after this was answered: never issued if it hadn't been, fenced if it had.
		if (undelivered) return closeNow("turn_stopped");
		await tx
			.update(codexApprovals)
			.set({ fencedAt: at, updatedAt: at })
			.where(
				and(
					eq(codexApprovals.id, row.id),
					eq(codexApprovals.status, "answered"),
					isNull(codexApprovals.fencedAt),
				),
			);
		return decline();
	}
	if (decision === "accept" && parseMs(now.answeredAt) < parseMs(cutoff)) {
		// Past the delivery window: never issue it now.
		if (undelivered) return closeNow("answer_lapsed");
		return decline();
	}
	return decline();
}

/**
 * The host's 1 s poll. One transaction. Ownership comes from the authenticated
 * host through the owner-of-record rule on every id: another host's ids, and ids
 * the server doesn't know, come back in `closed` and change nothing.
 *
 * With nothing to do this is one statement.
 */
export async function syncApprovals(
	supervisorId: string,
	body: CodexApprovalSyncRequest,
	deps?: ApprovalDeps,
): Promise<CodexApprovalSyncResponse> {
	const nowMs = clockOf(deps);
	const liveRevisions = new Map(body.live.map((entry) => [entry.approvalId, entry.revision]));
	const resolvedIds = new Set(body.resolved.map((entry) => entry.approvalId));
	const listed = [...new Set([...liveRevisions.keys(), ...resolvedIds])];

	const out = {
		answers: [] as CodexApprovalAnswer[],
		closedIds: [] as string[],
		closed: [] as ClosedApproval[],
		ack: [] as CodexApprovalAck[],
	};

	await withTransaction(async (tx) => {
		const rows = await readOwnedRows(tx, supervisorId, listed);
		const byId = new Map(rows.map((row) => [row.id, row]));

		for (const resolved of body.resolved) {
			const row = byId.get(resolved.approvalId);
			if (row) {
				const closed = await applyReportedOutcome(tx, row, resolved, nowMs);
				if (closed) {
					out.closed.push(closed);
					byId.set(row.id, { ...row, status: "closed", closedReason: closed.reason });
				}
			}
			// Acked once recorded; unknown, foreign and closed ids are acked the same way,
			// so the host forgets them and nothing tells it which of those it was.
			out.ack.push({ approvalId: resolved.approvalId, outcome: resolved.outcome });
		}

		for (const id of liveRevisions.keys()) {
			const row = byId.get(id);
			if (!row || row.status === "closed") out.closedIds.push(id);
		}

		for (const row of byId.values()) {
			if (row.status === "closed" || resolvedIds.has(row.id)) continue;
			const effective = deriveApprovalOutcome(row, nowMs);
			if (row.status === "pending" && effective.state === "closed") {
				const closed = await closeApproval(tx, row.id, "expired", nowMs, { fromStatus: "pending" });
				if (closed) out.closed.push(closed);
				out.closedIds.push(row.id);
				continue;
			}
			const missingFromLive =
				!liveRevisions.has(row.id) && nowMs - parseMs(row.createdAt) >= CODEX_NEW_ROW_GRACE_MS;
			if (missingFromLive) {
				const reason = issuedAccept(row) ? "outcome_unknown" : "runtime_gone";
				const closed = await closeApproval(tx, row.id, reason, nowMs);
				if (closed) out.closed.push(closed);
				out.closedIds.push(row.id);
				continue;
			}
			// A host that already reported sending its answer needs nothing issued again.
			if (row.status === "answered" && row.hostOutcome === null) {
				await issueOrRefuse(tx, row, nowMs, out, liveRevisions.get(row.id), deps);
			}
		}
	});

	await runApprovalClosedEffects(out.closed, deps);
	return {
		v: 1,
		answers: out.answers,
		closed: [...new Set(out.closedIds)],
		ack: out.ack,
	};
}

// ── the sweep ───────────────────────────────────────────────────────────────

type SweepAction =
	| { kind: "close"; reason: ApprovalClosedReason; onlyUndelivered: boolean }
	| { kind: "fence" };

/** What the sweep must write for one open row, or null when the row needs nothing. */
function sweepActionFor(
	row: ApprovalRow,
	sessionStopping: boolean,
	nowMs: number,
): SweepAction | null {
	if (sessionStopping) {
		if (row.status === "answered" && row.firstDeliveredAt !== null) {
			// An accept already issued can't be un-issued: fence it so it is never issued again.
			return row.fencedAt === null ? { kind: "fence" } : null;
		}
		return { kind: "close", reason: "session_stopped", onlyUndelivered: true };
	}
	const effective = deriveApprovalOutcome(row, nowMs);
	if (effective.state !== "closed" || effective.closedReason === null) return null;
	return { kind: "close", reason: effective.closedReason, onlyUndelivered: false };
}

export interface SweepResult {
	closed: number;
	fenced: number;
	waitsRemoved: number;
	waitsAdded: number;
}

const SWEEP_ROW_LIMIT = 1000;

/**
 * Every 30 s (and once at boot with `full`). Writes what the clock and the
 * database have decided but no reader or sync has yet:
 *  - a pending row past its expiry closes `expired`;
 *  - an accept not issued within 60 s closes `answer_lapsed`; one issued and
 *    never reported on closes `outcome_unknown` after 5 minutes;
 *  - an answered decline past expiry closes `applied` (it can't have run);
 *  - an open row in a session with a Stop queued or running (a row made after the
 *    Stop's fence, or one the fence couldn't see) closes `session_stopped`, or is
 *    fenced if an accept was already issued;
 *  - the permission wait is brought in line with the open rows, in one transaction
 *    per session that differs, from one batched read of metadata.
 * `full` also looks at every session whose metadata carries an approval wait, to
 * find one left behind by a crash between a row closing and its wait clearing.
 */
export async function sweepApprovals(
	options: { full?: boolean } = {},
	deps?: ApprovalDeps,
): Promise<SweepResult> {
	// One pass at a time in this process: a slow pass must not stack another behind it.
	if (sweepRunning) return { closed: 0, fenced: 0, waitsRemoved: 0, waitsAdded: 0 };
	sweepRunning = true;
	try {
		return await sweepOnce(options, deps);
	} finally {
		sweepRunning = false;
	}
}

let sweepRunning = false;

async function sweepOnce(options: { full?: boolean }, deps?: ApprovalDeps): Promise<SweepResult> {
	const nowMs = clockOf(deps);
	const at = iso(nowMs);
	const result: SweepResult = { closed: 0, fenced: 0, waitsRemoved: 0, waitsAdded: 0 };
	const db = getDb();

	const open: ApprovalRow[] = await db
		.select()
		.from(codexApprovals)
		.where(inArray(codexApprovals.status, [...OPEN_STATUSES]))
		.orderBy(asc(codexApprovals.expiresAt))
		.limit(SWEEP_ROW_LIMIT);

	const stoppedSessions = new Set<string>();
	if (open.length > 0) {
		const ids = [...new Set(open.map((row) => row.sessionId))];
		const rows = await db
			.select({ sessionId: managedSessions.sessionId })
			.from(managedSessions)
			.innerJoin(controlActions, eq(controlActions.id, managedSessions.activeControlActionId))
			.where(
				and(
					inArray(managedSessions.sessionId, ids),
					eq(controlActions.actionType, "stop"),
					inArray(controlActions.status, ["queued", "running"]),
				),
			);
		for (const row of rows) stoppedSessions.add(row.sessionId);
	}

	const closedAll: ClosedApproval[] = [];
	const stillOpen = new Map<string, string[]>();
	const keepOpen = (row: ApprovalRow): void => {
		stillOpen.set(row.sessionId, [...(stillOpen.get(row.sessionId) ?? []), row.id]);
	};
	for (const row of open) {
		const action = sweepActionFor(row, stoppedSessions.has(row.sessionId), nowMs);
		if (action === null) {
			keepOpen(row);
			continue;
		}
		const outcome = await withTransaction(async (tx): Promise<ClosedApproval | "fenced" | null> => {
			if (action.kind === "fence") {
				const fenced = await tx
					.update(codexApprovals)
					.set({ fencedAt: at, updatedAt: at })
					.where(
						and(
							eq(codexApprovals.id, row.id),
							eq(codexApprovals.status, "answered"),
							isNull(codexApprovals.fencedAt),
						),
					)
					.returning({ id: codexApprovals.id });
				return fenced.length > 0 ? "fenced" : null;
			}
			return closeApproval(tx, row.id, action.reason, nowMs, {
				fromStatus: row.status as ApprovalStatus,
				onlyUndelivered: action.onlyUndelivered,
			});
		});
		if (outcome === "fenced") {
			result.fenced++;
			keepOpen(row);
		} else if (outcome) {
			closedAll.push(outcome);
			result.closed++;
		} else {
			keepOpen(row);
		}
	}
	await runApprovalClosedEffects(closedAll, deps);

	await reconcileWaits(stillOpen, options.full === true, result);
	return result;
}

async function reconcileWaits(
	openBySession: Map<string, string[]>,
	full: boolean,
	result: SweepResult,
): Promise<void> {
	const candidates = new Set<string>([...openBySession.keys(), ...waitRepair]);
	if (full) {
		const rows = await getDb()
			.select({ sessionId: sessions.sessionId })
			.from(sessions)
			.where(sql`cast(${sessions.metadata} as text) like ${"%approval:%"}`);
		for (const row of rows) candidates.add(row.sessionId);
	}
	if (candidates.size === 0) return;
	const ids = [...candidates];
	const stored = await getDb()
		.select({ sessionId: sessions.sessionId, metadata: sessions.metadata })
		.from(sessions)
		.where(inArray(sessions.sessionId, ids));
	for (const row of stored) {
		const wait = (row.metadata as Record<string, unknown> | null)?.permissionWait as
			| { ids?: unknown }
			| undefined;
		const held = Array.isArray(wait?.ids)
			? (wait.ids as unknown[]).filter(
					(id): id is string => typeof id === "string" && id.startsWith("approval:"),
				)
			: [];
		const wanted = (openBySession.get(row.sessionId) ?? []).map(approvalWaitId);
		const agrees = held.length === wanted.length && wanted.every((id) => held.includes(id));
		if (agrees) {
			waitRepair.delete(row.sessionId);
			continue;
		}
		try {
			const changed = await reconcileApprovalWait(
				row.sessionId,
				openBySession.get(row.sessionId) ?? [],
			);
			result.waitsRemoved += changed.removedStale;
			result.waitsAdded += changed.added;
			waitRepair.delete(row.sessionId);
			await broadcastSession(row.sessionId).catch(() => undefined);
		} catch {
			waitRepair.add(row.sessionId);
			logEffectFailure("codex_approval_reconcile_failed", row.sessionId);
		}
	}
}

// ── retention ───────────────────────────────────────────────────────────────

/**
 * Deletes closed rows whose expiry is older than `cutoffIso`, in batches, through
 * the `(status, expires_at)` index. Open rows never go. The audit is never
 * touched (its rows are final by now; the delete trigger is a no-op on them).
 */
export async function deleteClosedApprovals(
	cutoffIso: string,
	batchSize: number,
	maxBatches: number,
): Promise<number> {
	const db = getDb();
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const batch: Array<{ id: string }> = await db
			.select({ id: codexApprovals.id })
			.from(codexApprovals)
			.where(and(eq(codexApprovals.status, "closed"), lt(codexApprovals.expiresAt, cutoffIso)))
			.orderBy(asc(codexApprovals.expiresAt))
			.limit(batchSize);
		if (batch.length === 0) break;
		await db.delete(codexApprovals).where(
			and(
				inArray(
					codexApprovals.id,
					batch.map((row) => row.id),
				),
				eq(codexApprovals.status, "closed"),
			),
		);
		deleted += batch.length;
		if (batch.length < batchSize) break;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return deleted;
}

/** Test seam: forget sessions queued for a wait repair. */
export function _resetApprovalWaitRepairForTest(): void {
	waitRepair.clear();
}
