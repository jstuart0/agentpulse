import type { AGENT_TYPES, SEMANTIC_STATUSES, SESSION_STATUSES } from "./constants.js";

// Agent types supported. Canonical const list lives in constants.ts;
// derive the type here for easy import discoverability.
export type AgentType = (typeof AGENT_TYPES)[number];

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
	| "UserPromptSubmit";

// Hook event types from Codex CLI
export type CodexEvent =
	| "SessionStart"
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop";

export type HookEventType = ClaudeCodeEvent | CodexEvent;

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
	turn_id?: string;
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
}

// Semantic status update from CLAUDE.md snippet
export interface SemanticStatusUpdate {
	session_id: string;
	status: SemanticStatus;
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
	defaultAgentType: AgentType | null;
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
	defaultAgentType?: AgentType | null;
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
	claudeMdContent: string | null;
	claudeMdPath: string | null;
	claudeMdUpdatedAt: string | null;
	notes: string | null;
	metadata: Record<string, unknown>;
	projectId: string | null;
	isArchived: boolean;
	managedSession?: ManagedSession | null;
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
}

// Dashboard stats
export interface DashboardStats {
	activeSessions: number;
	totalSessionsToday: number;
	totalToolUsesToday: number;
	byAgentType: Record<AgentType, number>;
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
	defaultAgentType: AgentType | null;
	defaultModel: string | null;
	defaultLaunchMode: LaunchMode | null;
}

export interface SessionTemplate {
	id: string;
	projectId: string | null;
	overriddenFields: string[];
	name: string;
	description: string | null;
	agentType: AgentType;
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
	agentType: AgentType;
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
	agentType: AgentType;
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
	agentTypes: AgentType[];
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
		};
		codex?: {
			available: boolean;
			command: string;
			resolvedPath: string | null;
			source: "auto" | "config";
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
}

export interface LaunchRequest {
	id: string;
	templateId: string | null;
	launchCorrelationId: string;
	agentType: AgentType;
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
}

export interface ControlAction {
	id: string;
	sessionId: string | null;
	launchRequestId: string | null;
	actionType: ControlActionType;
	requestedBy: string | null;
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
	agentType?: AgentType;
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
