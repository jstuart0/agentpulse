/**
 * Answering managed Codex approvals from AgentPulse (AGEN-87): the one place the
 * server and the supervisor share constants and wire shapes.
 *
 * Boundary, stated plainly: the trusted host supplies both the text a person
 * sees and the process that runs. `presentationHash` is an ETag for what the
 * server showed (it stops a stale view, a changed revision and a replay); it does
 * not prove a person read anything or that the display matches execution.
 *
 * Wire messages are versioned (`v: 1`), each a named exported interface, built
 * by allowlist serializers and pinned by fixture tests. Never on any response:
 * runtime_epoch, rpc_id, thread_id, turn_id, item_id, provider_approval_id,
 * first_delivered_at, fenced_at, key ids, user ids.
 */

/** How long a request waits for a person, then it is declined. The one site for server and supervisor. */
export const CODEX_APPROVAL_TTL_MS = 20 * 60 * 1000;
/** An accept must be issued to the host within this long of being answered; past it the host is handed a decline. */
export const CODEX_ACCEPT_DELIVERY_WINDOW_MS = 60 * 1000;
/** An accept issued and never reported on by the host closes `outcome_unknown` after this long. */
export const CODEX_OUTCOME_UNKNOWN_AFTER_MS = 5 * 60 * 1000;
/** A row missing from a sync's `live` list closes `runtime_gone`, unless created this recently. */
export const CODEX_NEW_ROW_GRACE_MS = 30 * 1000;
/** Closed rows (and a `may_have_run` one) stay on the list this long. */
export const CODEX_CLOSED_VISIBLE_MS = 5 * 60 * 1000;

export const CODEX_APPROVAL_LIMITS = {
	openPerSession: 32,
	createdPer10MinPerSession: 60,
	createdWindowMs: 10 * 60 * 1000,
	openPerHost: 64,
	command: 16 * 1024,
	totalDiff: 256 * 1024,
	files: 200,
	pathChars: 1024,
	reasonChars: 4 * 1024,
	/** The server removes this many more characters from the end of any truncated field, after redaction. */
	secretCutMargin: 256,
	liveMax: 64,
	resolvedMax: 256,
	listMax: 52,
	previewBytes: 4 * 1024,
	syncBodyBytes: 256 * 1024,
	reportBodyBytes: 1024 * 1024,
	syncPerMinute: 120,
} as const;

export const APPROVAL_STATUSES = ["pending", "answered", "closed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_CLOSED_REASONS = [
	"applied",
	"expired",
	"answer_lapsed",
	"answer_withdrawn",
	"revision_changed",
	"outcome_unknown",
	"interrupted",
	"runtime_gone",
	"session_stopped",
] as const;
export type ApprovalClosedReason = (typeof APPROVAL_CLOSED_REASONS)[number];

export const APPROVAL_DECISIONS = ["accept", "decline", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_REQUEST_KINDS = ["command", "file_change"] as const;
export type ApprovalRequestKind = (typeof APPROVAL_REQUEST_KINDS)[number];

export const NOT_APPROVABLE_REASONS = [
	"redacted",
	"invisible_chars",
	"too_long",
	"no_diff",
	"no_command",
	"no_cwd",
	"write_stdin",
	"network",
	"grant_root",
	"unknown_param",
	"accept_not_offered",
] as const;
export type NotApprovableReason = (typeof NOT_APPROVABLE_REASONS)[number];

export const CODEX_APPROVAL_OUTCOMES = [
	"sending_accept",
	"sending_decline",
	"approved_sent",
	"declined",
	"declined_stopped",
	"expired",
	"answer_lapsed",
	"answer_withdrawn",
	"revision_changed",
	"may_have_run",
	"turn_ended",
	"codex_shut_down",
	"session_stopped",
	"approved_then_stopped",
] as const;
export type CodexApprovalOutcome = (typeof CODEX_APPROVAL_OUTCOMES)[number];

/** What the supervisor's tracker observed about a request, reported on sync. */
export const TRACKER_OUTCOMES = [
	"respond_sent",
	"resolved_after_response",
	"resolved_timeout",
	"resolved_before_response",
	"declined_slow_response",
	"declined_revision_changed",
	"declined_local",
	"runtime_gone",
	"runtime_gone_after_response",
] as const;
export type TrackerOutcome = (typeof TRACKER_OUTCOMES)[number];

/**
 * The D17 outcome protocol, as data. `accept` is the row result when the
 * decision the tracker sent (or, for the outcomes that mean it declined in place
 * of an accept, the row's decision) is `accept`; `other` when it is a decline or
 * a cancel. `null` means the row is not closed by this outcome.
 *
 * An accept is `applied` only from `resolved_after_response`, never from a send.
 * A sent decline or cancel with no `resolved` also closes `applied`, because a
 * lost confirmation can't make it run.
 */
export const TRACKER_OUTCOME_TABLE: Readonly<
	Record<
		TrackerOutcome,
		{
			terminal: boolean;
			accept: ApprovalClosedReason | null;
			other: ApprovalClosedReason | null;
		}
	>
> = {
	respond_sent: { terminal: false, accept: null, other: null },
	resolved_after_response: { terminal: true, accept: "applied", other: "applied" },
	resolved_timeout: { terminal: true, accept: "outcome_unknown", other: "applied" },
	resolved_before_response: { terminal: true, accept: "interrupted", other: "interrupted" },
	declined_slow_response: { terminal: true, accept: "answer_lapsed", other: "applied" },
	declined_revision_changed: { terminal: true, accept: "revision_changed", other: "applied" },
	declined_local: { terminal: true, accept: "answer_lapsed", other: "applied" },
	runtime_gone: { terminal: true, accept: "runtime_gone", other: "runtime_gone" },
	runtime_gone_after_response: { terminal: true, accept: "outcome_unknown", other: "applied" },
};

// ── Person DTOs ────────────────────────────────────────────────────────────

export interface CodexApprovalHost {
	state: "live" | "offline" | "gone";
	name: string | null;
}

export interface CodexApprovalViewer {
	canAccept: boolean;
}

export interface CodexApprovalPathPreview {
	path: string;
	kind: string;
}

/** At most 4 KiB per item. */
export interface CodexApprovalPreview {
	cwd: string | null;
	commandHead?: string;
	lastLines?: string;
	lineCount?: number;
	charCount?: number;
	fileCount?: number;
	paths?: CodexApprovalPathPreview[];
	pathOutsideCwd: boolean;
	nonAscii: boolean;
}

export interface CodexApprovalSummary {
	id: string;
	requestKind: ApprovalRequestKind;
	state: ApprovalStatus;
	outcome: CodexApprovalOutcome | null;
	decision: ApprovalDecision | null;
	answeredAt: string | null;
	revision: number;
	presentationHash: string;
	approvable: boolean;
	notApprovableReason: NotApprovableReason | null;
	canCancel: boolean;
	createdAt: string;
	expiresAt: string;
	expiresInSeconds: number;
	preview: CodexApprovalPreview | null;
}

export interface CodexApprovalList {
	v: 1;
	approvals: CodexApprovalSummary[];
	host: CodexApprovalHost;
	viewer: CodexApprovalViewer;
}

/** One changed file, as shown and hashed. */
export interface CodexApprovalPresentationChange {
	path: string;
	kind: string;
	movePath: string | null;
	diff: string;
}

/**
 * What a person is shown and what the hash covers: the redacted, server-built
 * text. A command request carries `command` and no `changes`; a file change the
 * reverse. Every key is always present for its kind, so the canonical JSON is
 * stable.
 */
export interface CodexApprovalCommandPresentation {
	v: 1;
	requestKind: "command";
	command: string | null;
	cwd: string | null;
	reason: string | null;
	grantRoot: string | null;
}
export interface CodexApprovalFileChangePresentation {
	v: 1;
	requestKind: "file_change";
	changes: CodexApprovalPresentationChange[];
	cwd: string | null;
	reason: string | null;
	grantRoot: string | null;
}
export type CodexApprovalPresentation =
	| CodexApprovalCommandPresentation
	| CodexApprovalFileChangePresentation;

export interface CodexApprovalDetail {
	v: 1;
	approval: CodexApprovalSummary;
	presentation: CodexApprovalPresentation | null;
	reasonText: string | null;
}

export interface CodexApprovalDecisionRequest {
	decision: ApprovalDecision;
	presentationHash?: string;
}

export interface CodexApprovalDecisionResponse {
	v: 1;
	approval: CodexApprovalSummary;
}

// ── Supervisor wire ────────────────────────────────────────────────────────

export interface CodexApprovalChange {
	path: string;
	kind: string;
	movePath?: string | null;
	diff?: string | null;
}

export interface CodexApprovalReportRequest {
	v: 1;
	runtimeEpoch: string;
	rpcId: string;
	requestKind: ApprovalRequestKind;
	threadId: string;
	turnId: string;
	itemId: string;
	providerApprovalId: string | null;
	ageMs: number;
	revision: number;
	command?: string | null;
	cwd?: string | null;
	reason?: string | null;
	grantRoot?: string | null;
	changes?: CodexApprovalChange[];
	truncated: boolean;
	declineOnly: NotApprovableReason[];
}

/** 201 for a new row, 200 for the same key again. */
export interface CodexApprovalReportResponse {
	v: 1;
	approvalId: string;
	revision: number;
	expiresInMs: number;
}

export interface CodexApprovalLive {
	approvalId: string;
	revision: number;
}

export interface CodexApprovalResolved {
	approvalId: string;
	outcome: TrackerOutcome;
	sentDecision: ApprovalDecision | null;
}

export interface CodexApprovalSyncRequest {
	v: 1;
	live: CodexApprovalLive[];
	resolved: CodexApprovalResolved[];
}

export interface CodexApprovalAnswer {
	approvalId: string;
	decision: ApprovalDecision;
	revision: number;
}

export interface CodexApprovalAck {
	approvalId: string;
	outcome: TrackerOutcome;
}

export interface CodexApprovalSyncResponse {
	v: 1;
	answers: CodexApprovalAnswer[];
	closed: string[];
	ack: CodexApprovalAck[];
}

/** The refusal codes a report or sync can get (HTTP mapping is the route's). */
export const APPROVAL_REPORT_REFUSALS = [
	"session_unknown",
	"too_many_pending",
	"session_stopping",
	"invalid_body",
] as const;
export type ApprovalReportRefusal = (typeof APPROVAL_REPORT_REFUSALS)[number];

/** The codes a person's answer can be refused with (HTTP mapping is the route's). */
export const APPROVAL_ANSWER_REFUSALS = [
	"invalid_decision",
	"not_owner",
	"human_required",
	"approval_not_found",
	"session_stopped",
	"already_resolved",
	"expired",
	"presentation_hash_required",
	"not_approvable",
	"host_offline",
	"host_gone",
	"presentation_changed",
] as const;
export type ApprovalAnswerRefusal = (typeof APPROVAL_ANSWER_REFUSALS)[number];

/** Prefix of the `tool_use_id` a Codex approval holds in `metadata.permissionWait`; reserved against hooks. */
export const APPROVAL_WAIT_ID_PREFIX = "approval:";

/** The event type the server writes when an approval row closes; reserved against hooks and supervisors. */
export const APPROVAL_RESOLVED_EVENT_TYPE = "ManagedApprovalResolved";

export function approvalWaitId(approvalId: string): string {
	return `${APPROVAL_WAIT_ID_PREFIX}${approvalId}`;
}

/**
 * How the supervisor treats each parameter of a Codex approval request (D5).
 * The allowlist is every property the committed experimental schema declares for
 * the two request types (the schema test holds them equal), so a Codex that adds
 * a property is noticed: any key not listed, with a non-null value, makes the
 * request decline-only `unknown_param`.
 *
 *  - `shown`: part of the presentation a person reviews.
 *  - `metadata`: identifiers and times, never shown.
 *  - `available_decisions`: a command with no plain `accept` offered (or the
 *    field absent) is decline-only `accept_not_offered`. A file change declares
 *    no such field, so its absence relies on the response enum (S4).
 *  - `ignored`: Codex's own parse or suggestion; never shown as if it were the
 *    command, and the decisions it implies are never offered.
 *  - `environment`: null or the local value is fine; anything else is `unknown_param`.
 *  - `kind`: `command` passes; `writeStdin` is decline-only `write_stdin`.
 *  - `network`: non-null is decline-only `network`.
 *  - `grant_root`: non-null is decline-only `grant_root`.
 *  - `decline_if_set`: non-null is decline-only `unknown_param`.
 */
export type ApprovalParamTreatment =
	| "shown"
	| "metadata"
	| "available_decisions"
	| "ignored"
	| "environment"
	| "kind"
	| "network"
	| "grant_root"
	| "decline_if_set";

export const COMMAND_APPROVAL_PARAMS: Readonly<Record<string, ApprovalParamTreatment>> = {
	additionalPermissions: "decline_if_set",
	approvalId: "metadata",
	availableDecisions: "available_decisions",
	command: "shown",
	commandActions: "ignored",
	cwd: "shown",
	environmentId: "environment",
	itemId: "metadata",
	kind: "kind",
	networkApprovalContext: "network",
	proposedExecpolicyAmendment: "ignored",
	proposedNetworkPolicyAmendments: "ignored",
	reason: "shown",
	startedAtMs: "metadata",
	threadId: "metadata",
	turnId: "metadata",
};

export const FILE_CHANGE_APPROVAL_PARAMS: Readonly<Record<string, ApprovalParamTreatment>> = {
	grantRoot: "grant_root",
	itemId: "metadata",
	reason: "shown",
	startedAtMs: "metadata",
	threadId: "metadata",
	turnId: "metadata",
};
