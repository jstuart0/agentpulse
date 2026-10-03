import type {
	AGENT_TYPES,
	LAUNCHABLE_AGENT_TYPES,
	SEMANTIC_STATUSES,
	SESSION_STATUSES,
} from "./constants.js";
import type { OwnerScopeEcho } from "./owner-scope.js";
import type { ActiveOperationalStatus, OperationalStatus } from "./session-state.js";

// Agent types supported. Canonical const list lives in constants.ts;
// derive the type here for easy import discoverability.
export type AgentType = (typeof AGENT_TYPES)[number];

// Agent types AgentPulse can launch a process for — a subset of AgentType
// (D5). Use isLaunchable() to narrow a session/request-derived AgentType
// (or raw string) down to this type; never an unchecked type assertion on
// such a value (enforced by the plan's drift-guard grep in Verification).
export type LaunchableAgentType = (typeof LAUNCHABLE_AGENT_TYPES)[number];

export const APPROVAL_POLICIES = [
	"default",
	"suggest",
	"auto",
	"manual",
	"untrusted",
	"on-failure",
] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_MODES = [
	"default",
	"workspace-write",
	"read-only",
	"danger-full-access",
] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

// LLM provider kinds. The canonical const drives runtime allowlists,
// fee tables, and UI dropdowns — adding a new kind here forces every
// consumer to handle it (or fail to compile).
export const KNOWN_PROVIDER_KINDS = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"openai_compatible",
	"cohere",
] as const;
export type ProviderKind = (typeof KNOWN_PROVIDER_KINDS)[number];

// AI watcher decision policies. ask_always = HITL on every continue;
// ask_on_risk = HITL only when risk-classifier flags the session;
// auto = continue without HITL (still subject to caps).
export const WATCHER_POLICIES = ["ask_always", "ask_on_risk", "auto"] as const;
export type WatcherPolicy = (typeof WATCHER_POLICIES)[number];

// Watcher decision kinds emitted by the LLM parser.
export const DECISION_KINDS = ["continue", "ask", "report", "stop", "wait"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

// Watcher run lifecycle states. Drives the `ai_watcher_runs` table and
// queue snapshot endpoint. Canonical here; re-exported from watcher-runs-service.
export type WatcherRunStatus =
	| "queued"
	| "claimed"
	| "running"
	| "succeeded"
	| "failed"
	| "expired"
	| "cancelled";

// What caused a watcher run to be enqueued. Stored in `ai_watcher_runs.trigger_kind`.
export type WatcherRunTriggerKind = "idle" | "stop" | "error" | "plan_completed" | "manual";

// Managed-session lifecycle states. Producers are the supervisor providers
// (claude-headless / claude-interactive / codex-managed) and the
// state-recorder (managed-session-state). Consumers (session-tracker,
// continuability classifier, web getSessionMode, status hints) must
// handle every member exhaustively — the union below is the canonical
// allowlist. Order is roughly lifecycle:
//   pending → active(interactive_terminal | headless | managed | linked)
//          → degraded → stopped/completed/failed (terminal).
// LIVE_MANAGED_STATES (session-tracker.ts) preserves its own subset
// order; do not reorder by re-deriving from this tuple.
export const MANAGED_STATES = [
	"pending",
	"interactive_terminal",
	"headless",
	"managed",
	"linked",
	"degraded",
	"stopped",
	"completed",
	"failed",
] as const;
export type ManagedState = (typeof MANAGED_STATES)[number];

// HITL reply actions accepted from the inbox / session detail.
export const HITL_REPLY_KINDS = ["approve", "decline", "custom"] as const;
export type HitlReplyKind = (typeof HITL_REPLY_KINDS)[number];

// Project-scoped alert rule types. Drives the runtime allowlist in
// action-requests-service (rejecting unsupported types from Ask intents),
// the executor's exhaustive switch in ruleTypeLabel, and the alert-rule
// evaluator's per-type sweeps. Adding a kind here forces every consumer
// to handle it (or fail to compile via the `never` exhaustive guard).
export const KNOWN_ALERT_RULE_TYPES = [
	"status_failed",
	"status_stuck",
	"status_completed",
	"no_activity_minutes",
] as const;
export type AlertRuleType = (typeof KNOWN_ALERT_RULE_TYPES)[number];

// Notification channel transports. Drives both the runtime allowlist
// for inbox composition and the action-request executor; web `api.ts`
// re-exports for client-side type sharing.
export const KNOWN_NOTIFICATION_CHANNEL_KINDS = ["telegram", "webhook", "email"] as const;
export type NotificationChannelKind = (typeof KNOWN_NOTIFICATION_CHANNEL_KINDS)[number];

// Bare session-mutation actions used by:
//   - Bulk session action handler (`stop` | `archive` | `delete`)
//   - Single-session destructive intents (mapped via mutationKindToInboxKind)
// Distinct from the compound action_request kinds (`session_stop` etc.) —
// those are tied to the discriminated-union shape of ActionRequestPayload.
export const SESSION_MUTATION_KINDS = ["stop", "archive", "delete"] as const;
export type SessionMutationKind = (typeof SESSION_MUTATION_KINDS)[number];

// Origin of an Ask thread / action request — identifies whether the
// request was created via the dashboard chat UI or the Telegram bot.
// Drives notification routing and cross-channel reply attribution.
export const ASK_THREAD_ORIGINS = ["web", "telegram"] as const;
export type AskThreadOrigin = (typeof ASK_THREAD_ORIGINS)[number];

// Operator decision on an action request from the inbox cards. The
// server-side ActionRequestStatus union is wider — see
// `action-requests-service.ts` — but the operator-facing decision is
// strictly "applied" or "declined".
export const ACTION_REQUEST_DECISIONS = ["applied", "declined"] as const;
export type ActionRequestDecision = (typeof ACTION_REQUEST_DECISIONS)[number];

// Labs flag registry (experimental UI surfaces). Both the web client
// and the server's `labs-service.ts` import from this canonical list,
// so a new flag added here is visible to both sides at compile time.
// Defaults / labels / descriptions still live in `labs-service.ts`.
export const KNOWN_LABS_FLAGS = [
	"inbox",
	"digest",
	"aiSessionTab",
	"intelligenceBadges",
	"aiSettingsPanel",
	"templateDistillation",
	"launchRecommendation",
	"riskClasses",
	"telegramChannel",
	"askAssistant",
] as const;
export type LabsFlag = (typeof KNOWN_LABS_FLAGS)[number];
export type LabsFlags = Record<LabsFlag, boolean>;

// Ask thread message author roles.
export type AskMessageRole = "user" | "assistant" | "system";

export type LaunchMode = "interactive_terminal" | "headless" | "managed_codex";
export type ProviderSyncState = "pending" | "synced" | "failed";
export type LaunchRoutingPolicy = "manual_target" | "first_capable_host";
export type ControlActionType =
	| "stop"
	| "retry"
	| "fork"
	| "resume"
	| "rename"
	| "prompt"
	| "cleanup_workarea";
export type ControlActionStatus = "queued" | "running" | "succeeded" | "failed";
export type EventSource =
	| "observed_hook"
	| "observed_status"
	| "observed_transcript"
	| "managed_control"
	| "launch_system";

// Session lifecycle status. Canonical const list lives in constants.ts.
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Semantic status reported by agents via CLAUDE.md snippet.
// Canonical const list lives in constants.ts.
export type SemanticStatus = (typeof SEMANTIC_STATUSES)[number];

// Hook event types from Claude Code
export type ClaudeCodeEvent =
	| "SessionStart"
	| "SessionEnd"
	| "PreToolUse"
	| "PostToolUse"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "TaskCreated"
	| "TaskCompleted"
	| "UserPromptSubmit"
	| "PermissionRequest"
	| "PermissionDenied"
	| "Notification"
	| "PreCompact"
	| "PostCompact"
	| "PostToolUseFailure";

// Hook event types from Codex CLI. The 10-event list was confirmed
// empirically against 0.144.5 (see F3 in
// thoughts/shared/plans/active/2026-07-17-deliver-client-currency-remediation.md).
// "SessionEnd" and "Interrupt" were added per the current doc's 12-event
// hooks schema (learn.chatgpt.com/docs/hooks) and Phase 0's live/docs-derived
// fixture capture — see the 2026-09-28-deliver-agent-cli-parity plan, D12.
export type CodexEvent =
	| "SessionStart"
	| "SessionEnd"
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop"
	| "Interrupt"
	| "SubagentStart"
	| "SubagentStop"
	| "PermissionRequest"
	| "PreCompact"
	| "PostCompact";

// Hook event types from GitHub Copilot CLI. Registered set (10 events),
// camelCase — Copilot's own naming convention, distinct from Claude/
// Codex's PascalCase. D7 (2026-09-28-deliver-agent-cli-parity, Phase 0).
// All 10 fixtures are docs-derived (_source:"docs") — see
// src/server/services/agents/__fixtures__/SPIKE.md fact 1: every live
// Copilot invocation failed pre-model with an org-policy 403, so no hook
// ever actually fired. Casing, field names and toolArgs shape are
// unverified against the real CLI (waivered; re-confirm before treating
// as ground truth).
export type CopilotEvent =
	| "sessionStart"
	| "sessionEnd"
	| "userPromptSubmitted"
	| "postToolUse"
	| "postToolUseFailure"
	| "agentStop"
	| "subagentStart"
	| "subagentStop"
	| "preCompact"
	| "errorOccurred";

// Maps each CopilotEvent to the canonical HookEventType this codebase
// already models (Claude/Codex's PascalCase convention) — the
// copilot_cli canonicalizer resolves hook_event_name through this table
// when the incoming payload doesn't already carry a Pascal/snake variant.
export const COPILOT_EVENT_TO_HOOK_EVENT: Record<CopilotEvent, HookEventType> = {
	sessionStart: "SessionStart",
	sessionEnd: "SessionEnd",
	userPromptSubmitted: "UserPromptSubmit",
	postToolUse: "PostToolUse",
	postToolUseFailure: "PostToolUseFailure",
	agentStop: "Stop",
	subagentStart: "SubagentStart",
	subagentStop: "SubagentStop",
	preCompact: "PreCompact",
	errorOccurred: "ErrorOccurred",
};

// Synthetic events produced by AgentPulse's own tooling (not by a CLI hook),
// delivered through the same POST /api/v1/hooks ingestion path. Kept out of
// the ClaudeCodeEvent/CodexEvent/CopilotEvent unions on purpose: those lists
// are mirrored into hook-setup templates (check-hook-event-parity), and
// nobody configures a CLI hook for these.
//
//   UserAcknowledge — the user acknowledged the latest finished agent turn
//   without starting new work (e.g. a successful Claude Code `/copy`,
//   detected by a relay-side transcript watcher). Carries `source` and
//   `acknowledged_at` (hook-side ISO timestamp, informational).
//   UserUnacknowledge — "mark as unseen" (AGEN): the dashboard cleared a
//   prior acknowledgement, putting the session back into WAITING/ERROR.
//   Carries `source` the same way UserAcknowledge does.
export type AgentPulseSyntheticEvent = "UserAcknowledge" | "UserUnacknowledge";

export type HookEventType =
	| ClaudeCodeEvent
	| CodexEvent
	| "ErrorOccurred"
	| AgentPulseSyntheticEvent;

// Raw hook event payload (union of fields from both agents)
export interface HookEventPayload {
	session_id: string;
	hook_event_name: string;
	cwd?: string;
	transcript_path?: string;
	permission_mode?: string;

	// Tool events
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	tool_use_id?: string;

	// Codex-specific
	model?: string;
	last_assistant_message?: string;

	// Claude Code subagent events
	agent_id?: string;
	agent_type?: string;
	agent_transcript_path?: string;

	// Claude Code task events
	task_id?: string;
	task_subject?: string;
	task_description?: string;

	// Session events
	source?: string;
	prompt?: string;

	// Notification events
	message?: string;

	// Compaction events (PreCompact/PostCompact)
	trigger?: string;

	// UserAcknowledge (synthetic): when the acknowledgement happened on the
	// client, e.g. the transcript record timestamp of a successful /copy.
	// Informational only — the server stamps its own receive time.
	acknowledged_at?: string;

	// Codex Stop/Interrupt: identifies the turn a terminal event closes, so
	// a same-turn event that arrives after it (D21 out-of-order tolerance)
	// can be recognized and suppressed from reopening isWorking.
	turn_id?: string;

	// Copilot: the agent's own (camelCase) event name, preserved separately
	// from the canonical hook_event_name so event-normalizer can surface it
	// as providerEventType (D7).
	// F244 (xander, re-verify): UNTRUSTED, agent-supplied data — sourced from
	// the request body, the `?event=` hint, or hook_event_name, all
	// attacker-influenced. Capped at 128 chars with control characters
	// stripped by the Copilot canonicalizer (F235) before it reaches here;
	// never splice raw into a log line, prompt, or shell command.
	provider_event_name?: string;
	// Copilot errorOccurred / postToolUseFailure: the agent's error text.
	error_message?: string;
}

// Semantic status update from CLAUDE.md snippet
export interface SemanticStatusUpdate {
	session_id: string;
	/** Optional on the wire; values outside SEMANTIC_STATUSES are dropped server-side. */
	status?: SemanticStatus;
	task?: string;
	plan?: string[];
}

export type EventCategory =
	| "prompt"
	| "assistant_message"
	| "progress_update"
	| "plan_update"
	| "tool_event"
	| "status_update"
	| "system_event"
	| "permission_event"
	// User acknowledged the latest finished turn (synthetic UserAcknowledge).
	| "user_ack"
	// AI watcher categories (only present when the AI feature is enabled)
	| "ai_proposal_pending"
	| "ai_proposal"
	| "ai_report"
	| "ai_hitl_request"
	| "ai_hitl_response"
	| "ai_continue_sent"
	| "ai_continue_blocked"
	| "ai_error";

// Project as returned by the API
export interface Project {
	id: string;
	name: string;
	cwd: string;
	githubRepoUrl: string | null;
	defaultAgentType: LaunchableAgentType | null;
	defaultModel: string | null;
	defaultLaunchMode: LaunchMode | null;
	notes: string | null;
	tags: string[];
	isFavorite: boolean;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface ProjectInput {
	name: string;
	cwd: string;
	githubRepoUrl?: string | null;
	defaultAgentType?: LaunchableAgentType | null;
	defaultModel?: string | null;
	defaultLaunchMode?: LaunchMode | null;
	notes?: string | null;
	tags?: string[] | null;
	isFavorite?: boolean;
	metadata?: Record<string, unknown> | null;
}

// Session as returned by the API
export interface Session {
	id: string;
	sessionId: string;
	displayName: string | null;
	agentType: AgentType;
	status: SessionStatus;
	cwd: string | null;
	transcriptPath: string | null;
	model: string | null;
	startedAt: string;
	lastActivityAt: string;
	endedAt: string | null;
	semanticStatus: SemanticStatus | null;
	currentTask: string | null;
	planSummary: string[] | null;
	totalToolUses: number;
	isWorking: boolean;
	isPinned: boolean;
	gitBranch: string | null;
	/**
	 * Derived, not a schema column — computed by mapSessionDto (D14/F48)
	 * from metadata.renameSource / metadata.lastAppliedNativeName.
	 * "user": a manual dashboard rename (renameSource==="user") pins the
	 * name against future native-name pulls. "native": displayName was
	 * last set by an agent's own native-name pull. "generated": neither —
	 * the adjective-noun default.
	 */
	nameSource: "user" | "native" | "generated";
	/** Mirrors metadata.nativeName — the last agent-reported name seen, even if a pin refused to apply it. Null if none has ever been observed. */
	nativeName: string | null;
	claudeMdContent: string | null;
	claudeMdPath: string | null;
	claudeMdUpdatedAt: string | null;
	notes: string | null;
	metadata: Record<string, unknown>;
	projectId: string | null;
	isArchived: boolean;
	/**
	 * Acknowledgement model. `lastAgentTurnCompletedAt` is set on every Stop;
	 * `lastUserAcknowledgedAt` on every UserPromptSubmit and UserAcknowledge.
	 * Both are server receive-time ISO timestamps so they compare against each
	 * other; both are null for sessions that predate the columns or have not
	 * seen the event yet. A finished turn newer than the acknowledgement means
	 * the user has not looked at the result (WAITING); otherwise the session is
	 * IDLE when not working. See `getOperationalStatus` in session-state.ts.
	 */
	lastAgentTurnCompletedAt: string | null;
	lastUserAcknowledgedAt: string | null;
	managedSession?: ManagedSession | null;
	/**
	 * Cheap presence flag: true when a managed_sessions row exists for this
	 * session. Populated by `getSessions()` (list) via one batched
	 * membership query — unlike `managedSession`, which only `getSession()`
	 * (detail) populates with the full joined row. Prefer this field over
	 * `Boolean(managedSession)` in list contexts; `managedSession` is never
	 * present on list rows.
	 */
	managed?: boolean;
	/**
	 * Derived from owner_user_id / ingest_key_id (mapSessionDto): "user" when
	 * the session has an owner, "service" when it's unowned but a service
	 * key's event created or filled it, "unassigned" when both are still
	 * null. Optional: an older server won't send it.
	 */
	ownerKind?: "user" | "service" | "unassigned";
	/**
	 * The user who owns this session (set once at creation; never mutated by
	 * ingest). Null when unassigned. Already on the wire via mapSessionDto's
	 * passthrough (ingestKeyId is the only field it strips) — declared here
	 * so client code (the acknowledge-permission check) can read it without
	 * an unchecked cast. Optional: an older server may not send it.
	 */
	ownerUserId?: string | null;
	/**
	 * Derived by mapSessionDto via getOperationalStatus (session-state.ts):
	 * the single source of truth for the dashboard's WORKING / WAITING /
	 * IDLE / ERROR / COMPLETED state. Optional: an older server won't send
	 * it, and a client-side fallback can still compute it from the raw
	 * fields above.
	 */
	operationalStatus?: OperationalStatus;
}

export interface ManagedSession {
	sessionId: string;
	launchRequestId: string;
	supervisorId: string;
	providerSessionId: string | null;
	providerThreadId: string | null;
	managedState: ManagedState;
	correlationSource: string | null;
	desiredThreadTitle: string | null;
	providerThreadTitle: string | null;
	providerSyncState: ProviderSyncState;
	providerSyncError: string | null;
	lastProviderSyncAt: string | null;
	providerProtocolVersion: string | null;
	providerCapabilitySnapshot: Record<string, unknown> | null;
	activeControlActionId: string | null;
	controlLockExpiresAt: string | null;
	hostName: string | null;
	hostAffinityReason: string | null;
	createdAt: string;
	updatedAt: string;
}

// Event as returned by the API
export interface SessionEvent {
	id: number;
	sessionId: string;
	eventType: string;
	category: EventCategory | null;
	source: EventSource;
	content: string | null;
	isNoise: boolean;
	providerEventType: string | null;
	toolName: string | null;
	toolInput: Record<string, unknown> | null;
	toolResponse: string | null;
	rawPayload: Record<string, unknown>;
	createdAt: string;
}

export interface LiveSessionEvent {
	id?: number;
	sessionId: string;
	eventType: string;
	category: EventCategory | null;
	source: EventSource;
	content: string | null;
	isNoise: boolean;
	providerEventType: string | null;
	toolName: string | null;
	toolInput: Record<string, unknown> | null;
	toolResponse: string | null;
	rawPayload: Record<string, unknown>;
	createdAt: string;
}

// API key info (never includes the actual key)
export interface ApiKeyInfo {
	id: string;
	name: string;
	keyPrefix: string;
	isActive: boolean;
	createdAt: string;
	lastUsedAt: string | null;
	/** Capability set. Parsed from the DB's JSON-text column; never raw TEXT. */
	scopes: string[];
	/** The user the key belongs to; null for a service key. Absent on an older server. */
	ownerUserId?: string | null;
	/** The user who minted it; null when no user did. Absent on an older server. */
	createdByUserId?: string | null;
	/** True when an ownerless manage key is kept as an admin service key. Absent on an older server. */
	adminService?: boolean;
	/** True when the key is a service key: admin-minted, kept as an admin service key, or listed as a plain one. Absent on an older server. */
	serviceKey?: boolean;
}

// Dashboard stats
/**
 * The dashboard's three tab sizes. They partition the scope: every session is
 * in exactly one tab, so the three add up to `total`, and each equals the
 * `total` of `GET /sessions?tab=<name>` under the same owner and scratch
 * parameters.
 */
export interface SessionTabCounts {
	active: number;
	completed: number;
	archived: number;
}

export interface DashboardStats {
	/**
	 * The owner scope this response applied (`{kind:"all"}` when none was asked
	 * for); `me` carries the user id it resolved to.
	 */
	ownerScope: OwnerScopeEcho;
	/**
	 * Every session in the applied scope, archived and completed included
	 * (scratch workspaces left out when the request excluded them) — the same
	 * set every other count here is a part of.
	 */
	total: number;
	/**
	 * With excludeScratch on: how many sessions in the applied owner scope were
	 * left out of every count here because they belong to a scratch workspace
	 * (0 when scratch isn't excluded). Counts and `total` don't include them.
	 */
	scratchHidden: number;
	activeSessions: number;
	totalSessionsToday: number;
	totalToolUsesToday: number;
	byAgentType: Record<AgentType, number>;
	/**
	 * The four operational counts (AGEN), computed server-side by the same
	 * classifier the DTO's operationalStatus field uses — correct beyond
	 * whatever page size a client happens to have fetched.
	 */
	operational: Record<ActiveOperationalStatus, number>;
	/**
	 * True when the bounded operational candidate scan
	 * (fetchOperationalCandidates, session-tracker.ts) hit its cap — the
	 * operational counts and any operational= filter may under-report.
	 * Surfaced on the dashboard as a small note on the status cards.
	 */
	truncated: boolean;
	/**
	 * Server-side counts for the Completed and Archived tab badges (AGEN) —
	 * correct beyond whatever page useSessions() has loaded. completedCount
	 * excludes archived rows (those count under archivedCount instead) and
	 * mirrors getOperationalStatus's own "completed" branch, including a
	 * dismissed failure.
	 */
	completedCount: number;
	archivedCount: number;
	/**
	 * The three tab sizes (see SessionTabCounts). `completed` and `archived`
	 * equal completedCount and archivedCount; `active` is every other session —
	 * unlike activeSessions, which counts only lifecycle status 'active'.
	 */
	tabCounts: SessionTabCounts;
}

/**
 * One owner's counts in GET /sessions/stats?group_by=owner. `active` is the
 * operational active set (working + waiting + idle + error), `idle` the
 * operational idle count, `completed` matches DashboardStats.completedCount's
 * rule; `total` counts every session the owner has, archived included.
 */
export interface OwnerStatsGroup {
	ownerUserId: string | null;
	ownerKind: "user" | "service" | "unassigned";
	total: number;
	active: number;
	idle: number;
	completed: number;
	/** This owner's tab sizes, counted as DashboardStats.tabCounts is. */
	tabCounts: SessionTabCounts;
	working: number;
	waiting: number;
	error: number;
}

/** GET /sessions/stats?group_by=owner. `truncated` as on DashboardStats. */
export interface OwnerStatsResponse {
	/** The owner scope this response applied; see DashboardStats.ownerScope. */
	ownerScope: OwnerScopeEcho;
	groups: OwnerStatsGroup[];
	truncated: boolean;
}

/**
 * GET /auth/me response shape (auth.ts:203-241). Canonical definition —
 * previously duplicated inline in src/web/lib/api.ts and (pre-extraction)
 * src/mcp/client.ts (AGEN-12 Phase 2 mid-build hardening, dexter Low:
 * consolidated to prevent a third copy). The standalone agentpulse-mcp
 * package (packages/agentpulse-mcp/) now vendors its own client-side copy
 * of this shape in its types.ts, by design (D3 of
 * thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md) — a
 * published npm package can't import this file directly. `source:
 * "authentik"` is a legacy alias retained for one
 * release (see AuthUser docstring, src/server/auth/middleware.ts) — new
 * responses emit "forwardauth". `scopes` is api_key-caller-only (AGEN-9/
 * AGEN-12 Phase 1, additive); forwardauth/local callers omit the field.
 */
export interface AuthMeResponse {
	authenticated: boolean;
	user: {
		name: string;
		source: "forwardauth" | "authentik" | "api_key" | "local";
		provider?: string | null;
		id: string | null;
		role: "user" | "admin" | null;
		scopes?: string[];
		/**
		 * users.id for local and SSO callers; the key's owner for api_key
		 * callers; null for service keys, DISABLE_AUTH, and supervisor
		 * credentials. Optional: an older server won't send it.
		 */
		userId?: string | null;
		/**
		 * A display label for the caller, never the stored
		 * "sso:provider:subject" username. Optional: an older server won't
		 * send it.
		 */
		displayName?: string | null;
		/**
		 * True until the user replaces a password someone else chose; the server
		 * refuses every other dashboard route with password_change_required
		 * meanwhile. Optional: an older server won't send it.
		 */
		mustChangePassword?: boolean;
		/**
		 * What the caller may do to team-owned things right now (admin, or
		 * member), resolved per request: an owned key reports its owner's
		 * current role, an ownerless manage key is an admin in solo and, in
		 * team mode, only when kept as an admin service key. Optional: an
		 * older server won't send it.
		 */
		effectiveRole?: "admin" | "member";
	} | null;
	signOutUrl: string | null;
	disableAuth: boolean;
	allowSignup: boolean;
	/** The instance mode for an authenticated caller. Optional: an older server won't send it. */
	mode?: "solo" | "team";
	/** True when AGENTPULSE_MODE fixes the mode, so the UI can't change it. Optional: an older server won't send it. */
	modeLockedByEnv?: boolean;
}

// WebSocket message types
export type WsMessageType =
	| "subscribe"
	| "unsubscribe"
	| "session_updated"
	| "session_created"
	| "session_ended"
	| "new_event"
	| "stats_updated"
	| "heartbeat";

export interface WsMessage {
	type: WsMessageType;
	data?: unknown;
	channels?: string[];
}

// Settings
export interface AppSettings {
	theme: "dark" | "light" | "system";
	publicUrl: string;
	sessionTimeoutMinutes: number;
	eventsRetentionDays: number;
}

// Subset of Project returned alongside GET /templates/:id for the editor to
// derive inherited vs. overridden field state without a separate projects fetch.
export interface ResolvedProjectData {
	id: string;
	name: string;
	cwd: string;
	defaultAgentType: LaunchableAgentType | null;
	defaultModel: string | null;
	defaultLaunchMode: LaunchMode | null;
}

export interface SessionTemplate {
	id: string;
	projectId: string | null;
	overriddenFields: string[];
	name: string;
	description: string | null;
	agentType: LaunchableAgentType;
	cwd: string;
	baseInstructions: string;
	taskPrompt: string;
	model: string | null;
	approvalPolicy: ApprovalPolicy | null;
	sandboxMode: SandboxMode | null;
	env: Record<string, string>;
	tags: string[];
	isFavorite: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SessionTemplateInput {
	name: string;
	description?: string | null;
	agentType: LaunchableAgentType;
	cwd: string;
	baseInstructions?: string;
	taskPrompt?: string;
	model?: string | null;
	approvalPolicy?: ApprovalPolicy | null;
	sandboxMode?: SandboxMode | null;
	env?: Record<string, string>;
	tags?: string[];
	isFavorite?: boolean;
}

// Discriminated union. `prelaunchActions` is invariably a single-element
// array today (one scaffold OR one clone, never chained — see plan §12.9);
// the array shape is kept for forward compatibility with future kinds
// (`create_worktree`, `seed_secrets`).
export type PrelaunchAction =
	| {
			kind: "scaffold_workarea";
			path: string;
			gitInit?: boolean;
			seedClaudeMd?: { content: string; path: string; sha256: string };
	  }
	| {
			// `gitInit` is intentionally absent — clone provides .git by definition.
			kind: "clone_repo";
			url: string;
			intoPath: string;
			branch?: string;
			depth?: number;
			timeoutSeconds?: number;
			seedClaudeMd?: { content: string; path: string; sha256: string };
	  };

export interface LaunchSpec {
	version: 1;
	launchCorrelationId: string;
	managedMode: "unmanaged_preview";
	agentType: LaunchableAgentType;
	launchMode?: LaunchMode;
	cwd: string;
	model: string | null;
	approvalPolicy: ApprovalPolicy | null;
	sandboxMode: SandboxMode | null;
	baseInstructions: string;
	taskPrompt: string;
	env: Record<string, string>;
	providerConfig: {
		command: string;
		cliArgs: string[];
		instructionsFile: "CLAUDE.md" | "AGENTS.md";
	};
	prelaunchActions?: PrelaunchAction[];
}

export interface ProviderLaunchGuidance {
	label: string;
	command: string;
	recommended: boolean;
	notes: string[];
}

export interface TemplateHostCompatibility {
	supervisorId: string;
	hostName: string;
	status: SupervisorStatus;
	platform: string;
	arch: string;
	ok: boolean;
	errors: string[];
	warnings: string[];
	executablePath: string | null;
}

export interface TemplatePreview {
	normalizedTemplate: SessionTemplateInput;
	launchSpec: LaunchSpec;
	guidance: {
		claudeCode: ProviderLaunchGuidance;
		codexCli: ProviderLaunchGuidance;
	};
	warnings: string[];
	hostCompatibility: TemplateHostCompatibility[];
	firstCapableHostId: string | null;
}

export type SupervisorStatus = "connected" | "stale" | "offline";
export type LaunchRequestStatus =
	| "draft"
	| "queued"
	| "validated"
	| "rejected"
	| "launching"
	| "awaiting_session"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface SupervisorCapabilities {
	version: 1;
	agentTypes: LaunchableAgentType[];
	launchModes: LaunchMode[];
	os: "macos" | "linux" | "windows" | "unknown";
	terminalSupport: string[];
	features: string[];
	interactiveTerminalControl?: {
		available: boolean;
		reason: string | null;
	};
	executables?: {
		claude?: {
			available: boolean;
			command: string;
			resolvedPath: string | null;
			source: "auto" | "config";
			/**
			 * Parsed `claude --version` output, captured at supervisor
			 * start/registration. `null` when the executable is missing,
			 * `--version` fails, or output has no recognizable version
			 * token. Optional so older supervisors registering without
			 * this field remain valid. Stale until the supervisor
			 * restarts (not re-captured on every heartbeat).
			 */
			binaryVersion?: string | null;
		};
		codex?: {
			available: boolean;
			command: string;
			resolvedPath: string | null;
			source: "auto" | "config";
			/** Parsed `codex --version` output; see claude.binaryVersion. */
			binaryVersion?: string | null;
		};
	};
}

export interface SupervisorRecord {
	id: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	capabilities: SupervisorCapabilities;
	trustedRoots: string[];
	status: SupervisorStatus;
	capabilitySchemaVersion: number;
	configSchemaVersion: number;
	lastHeartbeatAt: string;
	heartbeatLeaseExpiresAt: string;
	enrollmentState?: "pending" | "active" | "revoked";
	createdAt: string;
	updatedAt: string;
	/** The caller who enrolled (or, for a pre-upgrade host, later rotated) this supervisor. Null if never attributed. */
	ownerUserId?: string | null;
}

export interface LaunchRequest {
	id: string;
	templateId: string | null;
	launchCorrelationId: string;
	agentType: LaunchableAgentType;
	cwd: string;
	baseInstructions: string;
	taskPrompt: string;
	model: string | null;
	approvalPolicy: ApprovalPolicy | null;
	sandboxMode: SandboxMode | null;
	requestedLaunchMode: LaunchMode;
	env: Record<string, string>;
	launchSpec: LaunchSpec;
	requestedBy: string | null;
	requestedSupervisorId: string | null;
	routingPolicy: LaunchRoutingPolicy | null;
	resolvedSupervisorId: string | null;
	routingDecision: Record<string, unknown> | null;
	claimedBySupervisorId: string | null;
	claimToken: string | null;
	status: LaunchRequestStatus;
	error: string | null;
	validationWarnings: string[];
	validationSummary: string | null;
	dispatchStartedAt: string | null;
	dispatchFinishedAt: string | null;
	awaitingSessionDeadlineAt: string | null;
	pid: number | null;
	providerLaunchMetadata: Record<string, unknown> | null;
	retryOfLaunchRequestId: string | null;
	metadata: Record<string, unknown> | null;
	desiredDisplayName: string | null;
	createdAt: string;
	updatedAt: string;
	/** The user who requested this launch. Null for DISABLE_AUTH / unattributed callers. */
	requestedByUserId: string | null;
}

export interface ControlAction {
	id: string;
	sessionId: string | null;
	launchRequestId: string | null;
	actionType: ControlActionType;
	requestedBy: string | null;
	/** The user who requested this action. Null for DISABLE_AUTH / unattributed callers. */
	requestedByUserId: string | null;
	status: ControlActionStatus;
	error: string | null;
	metadata: Record<string, unknown> | null;
	idempotencyKey: string | null;
	claimedBySupervisorId: string | null;
	finishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ManagedSessionStateInput {
	sessionId: string;
	agentType?: LaunchableAgentType;
	cwd?: string | null;
	model?: string | null;
	status?: SessionStatus;
	managedState?: ManagedState;
	launchRequestId?: string | null;
	providerSessionId?: string | null;
	providerThreadId?: string | null;
	correlationSource?: string | null;
	desiredThreadTitle?: string | null;
	providerThreadTitle?: string | null;
	providerSyncState?: ProviderSyncState;
	providerSyncError?: string | null;
	lastProviderSyncAt?: string | null;
	providerProtocolVersion?: string | null;
	providerCapabilitySnapshot?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
}

export interface ManagedSessionEventInput {
	eventType: string;
	category: EventCategory;
	source?: EventSource;
	content?: string | null;
	isNoise?: boolean;
	providerEventType?: string | null;
	rawPayload?: Record<string, unknown>;
}

export interface SupervisorRegistrationInput {
	id?: string;
	enrollmentToken?: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	capabilities: SupervisorCapabilities;
	trustedRoots: string[];
	capabilitySchemaVersion?: number;
	configSchemaVersion?: number;
}

export interface SupervisorEnrollmentTokenInfo {
	id: string;
	name: string;
	supervisorId?: string | null;
	tokenPrefix: string;
	isActive: boolean;
	expiresAt: string | null;
	createdAt: string;
	usedAt: string | null;
	revokedAt: string | null;
	/** The caller who created this token (enroll or rotate). Null when there was no caller userId. */
	createdByUserId: string | null;
}

export interface LaunchRequestInput {
	templateId?: string | null;
	requestedSupervisorId?: string | null;
	requestedLaunchMode?: LaunchMode;
	routingPolicy?: LaunchRoutingPolicy | null;
	template: SessionTemplateInput;
	launchSpec: LaunchSpec;
	metadata?: Record<string, unknown> | null;
	desiredDisplayName?: string | null;
}

// ----------------------------------------------------------------------
// Operator inbox (AI control plane). Discriminated union: each `kind`
// is rendered by a dedicated card on the client. Server is authoritative
// — the server composes these from canonical sources (HITL, classifier,
// failed proposals, action requests). Client must render every kind to
// stay exhaustive, so adding a new kind here forces a client switch
// update at compile time.
//
// Action-request-derived kinds (`action_*`) have null sessionId because
// they are project- or fleet-scoped, not session-scoped.
// ----------------------------------------------------------------------

export type InboxSeverity = "normal" | "high" | "info";

export type InboxWorkItem =
	| {
			kind: "hitl";
			id: string; // hitl request id
			sessionId: string;
			sessionName: string | null;
			proposalId: string;
			// Narrow of DecisionKind — breaks at compile time if "continue" or
			// "ask" is removed from the watcher decision union.
			decision: Extract<DecisionKind, "continue" | "ask">;
			prompt: string;
			why: string | null;
			openedAt: string;
			severity: InboxSeverity;
	  }
	| {
			kind: "stuck";
			id: string; // stable session-derived id
			sessionId: string;
			sessionName: string | null;
			since: string;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "risky";
			id: string;
			sessionId: string;
			sessionName: string | null;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "failed_proposal";
			id: string; // proposal id
			sessionId: string;
			sessionName: string | null;
			errorSubType: string | null;
			errorMessage: string | null;
			at: string;
			severity: InboxSeverity;
	  }
	| {
			// Action requests are NOT session-scoped. sessionId/sessionName are
			// always null — the UI must branch on kind to avoid rendering a broken
			// session link. See InboxPage.tsx for the conditional renderer.
			kind: "action_launch";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectId: string;
			projectName: string;
			template: SessionTemplateInput;
			launchSpec: LaunchSpec;
			requestedLaunchMode: LaunchMode;
			origin: AskThreadOrigin;
			/** Present when this launch was created by a resume intent. */
			parentSessionId: string | null;
			parentSessionName: string | null;
	  }
	| {
			kind: "action_add_project";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			projectCwd: string;
			defaultAgentType: string | null;
			defaultModel: string | null;
			defaultLaunchMode: string | null;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_session_stop";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_session_archive";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "normal";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_session_delete";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_edit_project";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "normal";
			projectId: string;
			projectName: string;
			fields: Record<string, unknown>;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_delete_project";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "high";
			projectId: string;
			projectName: string;
			affectedTemplates: number;
			affectedSessions: number;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_edit_template";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "normal";
			templateId: string;
			templateName: string;
			fields: Record<string, unknown>;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_delete_template";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "high";
			templateId: string;
			templateName: string;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_add_channel";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			channelKind: NotificationChannelKind;
			channelLabel: string;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			// Alert rule creation request. sessionId is null because rules are
			// project-scoped, not session-scoped.
			kind: "action_create_alert_rule";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			ruleType: string;
			thresholdMinutes: number | null;
			origin: AskThreadOrigin;
	  }
	| {
			// Freeform alert rule creation request. sessionId is null because rules are
			// project-scoped, not session-scoped.
			kind: "action_create_freeform_alert_rule";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			condition: string;
			dailyTokenBudget: number;
			origin: AskThreadOrigin;
	  }
	| {
			// Bulk session action. sessionId is null because this spans multiple sessions.
			// severity: "high" for stop/delete (irreversible); "normal" for archive.
			kind: "action_bulk_session";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "high" | "normal";
			createdAt: string;
			action: SessionMutationKind;
			sessionCount: number;
			sessionNames: string[]; // up to 20, each truncated to 40 chars
			hasMore: boolean; // true when sessionCount > 20
			exclusionCount: number;
			origin: AskThreadOrigin;
	  };

/**
 * Action-only subset of InboxWorkItem — every variant whose kind starts with
 * `action_`. Used by the unified ActionRequestCard component, which handles
 * Approve/Decline cards. Non-action variants (hitl, stuck, risky,
 * failed_proposal) have their own bespoke render paths.
 */
export type ActionInboxItem = Extract<InboxWorkItem, { kind: `action_${string}` }>;

export interface Inbox {
	items: InboxWorkItem[];
	total: number;
	byKind: Record<InboxWorkItem["kind"], number>;
}

export interface InboxFilter {
	kinds?: Array<InboxWorkItem["kind"]>;
	sessionId?: string;
	severity?: InboxSeverity;
	limit?: number;
}
