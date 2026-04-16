// Agent types supported
export type AgentType = "claude_code" | "codex_cli";

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
	notes: string | null;
	metadata: Record<string, unknown>;
}

// Event as returned by the API
export interface SessionEvent {
	id: number;
	sessionId: string;
	eventType: string;
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
