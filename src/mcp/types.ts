/**
 * Vendored wire-type closure (AGEN-12 follow-on, D3 — package extraction
 * campaign 2026-07-23-deliver-agentpulse-mcp-package, Phase 2).
 *
 * These types describe the wire contract of AgentPulse >= MIN_SERVER_VERSION
 * (see scopes.ts) as seen by this MCP client — response shapes only, no
 * server internals. Each type's canonical (server-side) source is named
 * below. Changing a server response shape is a cross-consumer change (this
 * file + src/web/lib/api.ts, which independently vendors its own client
 * view) and must either stay backward-compatible or bump MIN_SERVER_VERSION.
 *
 * This is a deliberate one-way vendor, not a shared package (D3 option A
 * over option B — a shared @agentpulse/types package is revisited only if a
 * third consumer of these wire types appears). The closure below is the
 * transitive dependency set of every type this module's client (client.ts)
 * and its tools/test files reference — not just the ~20 directly imported
 * names.
 *
 * Canonical sources:
 *   - 43 types from src/shared/types.ts (server-canonical shared shapes)
 *   - SessionIntelligence, HealthState, HealthReasonCode from
 *     src/server/services/ai/classifier.ts
 *   - Digest, RepoDigest, RepoDigestSession from
 *     src/server/services/ai/digest-service.ts
 *   - HitlRequestRecord, HitlStatus from
 *     src/server/services/ai/hitl-service.ts
 *   - RecommendedLaunch from src/server/services/ai/launch-recommender.ts
 *   - SearchResult, SearchHit, SearchRowKind from
 *     src/server/services/search/types.ts
 *   - ActionRequest, ActionRequestStatus from
 *     src/server/services/ai/action-requests-service.ts (payload
 *     deliberately simplified — see the comment at ActionRequest below)
 */

// ─── Literal unions (self-contained; mirror src/shared/constants.ts's
//     `as const` tuples and src/shared/types.ts's inline unions) ─────────

export type AgentType = "claude_code" | "codex_cli";
export type ApprovalPolicy = "default" | "suggest" | "auto" | "manual" | "untrusted" | "on-failure";
export type SandboxMode = "default" | "workspace-write" | "read-only" | "danger-full-access";
export type SemanticStatus =
	| "researching"
	| "implementing"
	| "testing"
	| "debugging"
	| "reviewing"
	| "documenting"
	| "planning"
	| "waiting";
export type SessionStatus = "active" | "idle" | "completed" | "failed" | "archived";
export type HitlReplyKind = "approve" | "decline" | "custom";
export type NotificationChannelKind = "telegram" | "webhook" | "email";
export type SessionMutationKind = "stop" | "archive" | "delete";
export type AskThreadOrigin = "web" | "telegram";
export type ActionRequestDecision = "applied" | "declined";
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
export type ManagedState =
	| "pending"
	| "interactive_terminal"
	| "headless"
	| "managed"
	| "linked"
	| "degraded"
	| "stopped"
	| "completed"
	| "failed";
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
export type DecisionKind = "continue" | "ask" | "report" | "stop" | "wait";
export type InboxSeverity = "normal" | "high" | "info";

export type EventCategory =
	| "prompt"
	| "assistant_message"
	| "progress_update"
	| "plan_update"
	| "tool_event"
	| "status_update"
	| "system_event"
	| "permission_event"
	| "ai_proposal_pending"
	| "ai_proposal"
	| "ai_report"
	| "ai_hitl_request"
	| "ai_hitl_response"
	| "ai_continue_sent"
	| "ai_continue_blocked"
	| "ai_error";

// ─── Structural shapes ────────────────────────────────────────────────

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

export interface ResolvedProjectData {
	id: string;
	name: string;
	cwd: string;
	defaultAgentType: AgentType | null;
	defaultModel: string | null;
	defaultLaunchMode: LaunchMode | null;
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
	managed?: boolean;
}

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

export interface DashboardStats {
	activeSessions: number;
	totalSessionsToday: number;
	totalToolUsesToday: number;
	byAgentType: Record<AgentType, number>;
}

/**
 * GET /auth/me response shape (src/server/routes/auth.ts). `source:
 * "authentik"` is a legacy alias retained for one release server-side; new
 * responses emit "forwardauth". `scopes` is api_key-caller-only —
 * forwardauth/local callers omit the field (this package's discoverScopes
 * relies on that).
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
	} | null;
	signOutUrl: string | null;
	disableAuth: boolean;
	allowSignup: boolean;
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
// array today (one scaffold OR one clone, never chained); the array shape
// is kept for forward compatibility with future kinds.
export type PrelaunchAction =
	| {
			kind: "scaffold_workarea";
			path: string;
			gitInit?: boolean;
			seedClaudeMd?: { content: string; path: string; sha256: string };
	  }
	| {
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
			binaryVersion?: string | null;
		};
		codex?: {
			available: boolean;
			command: string;
			resolvedPath: string | null;
			source: "auto" | "config";
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

// ─── Operator inbox (discriminated union) ──────────────────────────────

export type InboxWorkItem =
	| {
			kind: "hitl";
			id: string;
			sessionId: string;
			sessionName: string | null;
			proposalId: string;
			decision: Extract<DecisionKind, "continue" | "ask">;
			prompt: string;
			why: string | null;
			openedAt: string;
			severity: InboxSeverity;
	  }
	| {
			kind: "stuck";
			id: string;
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
			id: string;
			sessionId: string;
			sessionName: string | null;
			errorSubType: string | null;
			errorMessage: string | null;
			at: string;
			severity: InboxSeverity;
	  }
	| {
			kind: "action_launch";
			id: string;
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
			parentSessionId: string | null;
			parentSessionName: string | null;
	  }
	| {
			kind: "action_add_project";
			id: string;
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
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_session_archive";
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "normal";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_session_delete";
			id: string;
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_edit_project";
			id: string;
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
			id: string;
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
			id: string;
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
			id: string;
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
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "info";
			channelKind: NotificationChannelKind;
			channelLabel: string;
			createdAt: string;
			origin: AskThreadOrigin;
	  }
	| {
			kind: "action_create_alert_rule";
			id: string;
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
			kind: "action_create_freeform_alert_rule";
			id: string;
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
			kind: "action_bulk_session";
			id: string;
			sessionId: null;
			sessionName: null;
			severity: "high" | "normal";
			createdAt: string;
			action: SessionMutationKind;
			sessionCount: number;
			sessionNames: string[];
			hasMore: boolean;
			exclusionCount: number;
			origin: AskThreadOrigin;
	  };

export interface Inbox {
	items: InboxWorkItem[];
	total: number;
	byKind: Record<InboxWorkItem["kind"], number>;
}

// ─── AI service response shapes (each has exactly one canonical owner
//     outside src/mcp/ — direct type-import bar per client.ts's promote-to-
//     shared comment; vendored here for the same reason as the 43 above) ──

export type HealthState = "healthy" | "blocked" | "stuck" | "risky" | "complete_candidate";

export type HealthReasonCode =
	| "working"
	| "recently_active"
	| "idle_with_progress"
	| "hitl_pending_long"
	| "supervisor_offline"
	| "repeated_tool_failure"
	| "repeated_control_action_failure"
	| "consecutive_ai_errors"
	| "assistant_complete_hint"
	| "idle_after_plan_complete"
	| "no_signal";

export interface SessionIntelligence {
	health: HealthState;
	reasonCode: HealthReasonCode;
	explanation: string;
	confidence: number;
	evidence: string[];
	updatedAt: string;
}

export interface RepoDigestSession {
	sessionId: string;
	displayName: string | null;
	status: string;
	health: string | null;
	healthReason: string | null;
	lastActivityAt: string;
	totalToolUses: number;
}

export interface RepoDigest {
	repoKey: string;
	cwd: string | null;
	projectName: string;
	activeCount: number;
	blockedCount: number;
	stuckCount: number;
	completedToday: number;
	failedToday: number;
	topPlanCompletions: string[];
	notableFailures: Array<{ sessionId: string; message: string | null; at: string }>;
	sessions: RepoDigestSession[];
}

export interface Digest {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	totals: {
		repos: number;
		sessions: number;
		active: number;
		blocked: number;
		stuck: number;
		completedToday: number;
	};
	repos: RepoDigest[];
}

export type HitlStatus =
	| "draft"
	| "awaiting_reply"
	| "applied"
	| "declined"
	| "timed_out"
	| "superseded";

export interface HitlRequestRecord {
	id: string;
	proposalId: string;
	sessionId: string;
	channelId: string | null;
	status: HitlStatus;
	replyKind: HitlReplyKind | null;
	replyText: string | null;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface RecommendedLaunch {
	agentType: AgentType;
	model: string | null;
	launchMode: LaunchMode;
	suggestedSupervisorId: string | null;
	suggestedSupervisorHost: string | null;
	rationale: string[];
	warnings: string[];
	alternatives: Array<{
		agentType?: AgentType;
		model?: string | null;
		launchMode?: LaunchMode;
		reason: string;
	}>;
	confidence: number;
}

export type SearchRowKind = "session" | "event";

export interface SearchHit {
	kind: SearchRowKind;
	sessionId: string;
	eventId: number | null;
	eventType: string | null;
	snippet: string;
	score: number;
	timestamp: string;
	sessionDisplayName: string | null;
	sessionCwd: string | null;
}

export interface SearchResult {
	hits: SearchHit[];
	total: number;
	backend: "sqlite-fts5" | "postgres-ilike" | "postgres-tsvector";
}

export type ActionRequestStatus =
	| "awaiting_reply"
	| "applying"
	| "applied"
	| "failed"
	| "declined"
	| "expired"
	| "superseded";

/**
 * Deliberate simplification (D3): `payload` is typed `Record<string,
 * unknown>` and `kind` is `string` rather than the full 186-line
 * discriminated ActionRequestPayload union (action-requests-types.ts). This
 * client never reads payload fields — its only use is the opaque
 * passthrough `{ actionRequest: ActionRequest | null }` from
 * decideActionRequest (client.ts).
 */
export interface ActionRequest {
	id: string;
	kind: string;
	status: ActionRequestStatus;
	failureReason: string | null;
	question: string;
	payload: Record<string, unknown>;
	origin: AskThreadOrigin;
	channelId: string | null;
	askThreadId: string | null;
	resolvedAt: string | null;
	resolvedBy: string | null;
	resultEventId: string | null;
	createdAt: string;
	updatedAt: string;
}
