// Agent types supported
export type AgentType = "claude_code" | "codex_cli";

export type ApprovalPolicy =
	| "default"
	| "suggest"
	| "auto"
	| "manual"
	| "untrusted"
	| "on-failure";

export type SandboxMode =
	| "default"
	| "workspace-write"
	| "read-only"
	| "danger-full-access";

export type LaunchMode = "interactive_terminal" | "headless" | "managed_codex";

// Session lifecycle status
export type SessionStatus =
	| "active"
	| "idle"
	| "completed"
	| "failed"
	| "archived";

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
	| "system_event";

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
}

// Event as returned by the API
export interface SessionEvent {
	id: number;
	sessionId: string;
	eventType: string;
	category: EventCategory | null;
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

export interface SessionTemplate {
	id: string;
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
}

export interface ProviderLaunchGuidance {
	label: string;
	command: string;
	recommended: boolean;
	notes: string[];
}

export interface TemplatePreview {
	normalizedTemplate: SessionTemplateInput;
	launchSpec: LaunchSpec;
	guidance: {
		claudeCode: ProviderLaunchGuidance;
		codexCli: ProviderLaunchGuidance;
	};
	warnings: string[];
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
	| "failed"
	| "cancelled";

export interface SupervisorCapabilities {
	version: 1;
	agentTypes: AgentType[];
	launchModes: LaunchMode[];
	os: "macos" | "linux" | "windows" | "unknown";
	terminalSupport: string[];
	features: string[];
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
	createdAt: string;
	updatedAt: string;
}

export interface SupervisorRegistrationInput {
	id?: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	capabilities: SupervisorCapabilities;
	trustedRoots: string[];
	capabilitySchemaVersion?: number;
	configSchemaVersion?: number;
}

export interface LaunchRequestInput {
	templateId?: string | null;
	requestedSupervisorId?: string | null;
	requestedLaunchMode?: LaunchMode;
	template: SessionTemplateInput;
	launchSpec: LaunchSpec;
}
