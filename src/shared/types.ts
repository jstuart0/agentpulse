// Agent types supported
export type AgentType = "claude_code" | "codex_cli";

export type ApprovalPolicy = "default" | "suggest" | "auto" | "manual" | "untrusted" | "on-failure";

export type SandboxMode = "default" | "workspace-write" | "read-only" | "danger-full-access";

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

// Session lifecycle status
export type SessionStatus = "active" | "idle" | "completed" | "failed" | "archived";

// Semantic status reported by agents via CLAUDE.md snippet
export type SemanticStatus =
	| "researching"
	| "implementing"
	| "testing"
	| "debugging"
	| "reviewing"
	| "documenting"
	| "planning"
	| "waiting";

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
	managedState: string;
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
	managedState?: string;
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
			decision: "continue" | "ask";
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
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_stop";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_archive";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "normal";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_delete";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_add_channel";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			channelKind: "telegram" | "webhook" | "email";
			channelLabel: string;
			createdAt: string;
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
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
			origin: "web" | "telegram";
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
			action: "stop" | "archive" | "delete";
			sessionCount: number;
			sessionNames: string[]; // up to 20, each truncated to 40 chars
			hasMore: boolean; // true when sessionCount > 20
			exclusionCount: number;
			origin: "web" | "telegram";
	  };

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
