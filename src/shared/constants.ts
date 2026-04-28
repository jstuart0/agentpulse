// IMPORTANT: these `as const` tuples are the single source of truth for
// the matching string-literal-union types in shared/types.ts. Do NOT
// edit one without the other — adding a new value here automatically
// widens the type, but tightening Record<KindName, V> maps below will
// fail to compile until every consumer adds the new key.
import type { AgentType, SemanticStatus, SessionStatus } from "./types.js";

export const SEMANTIC_STATUSES = [
	"researching",
	"implementing",
	"testing",
	"debugging",
	"reviewing",
	"documenting",
	"planning",
	"waiting",
] as const;

export const SESSION_STATUSES = ["active", "idle", "completed", "failed", "archived"] as const;

export const AGENT_TYPES = ["claude_code", "codex_cli"] as const;

// Status colors for the dashboard
export const STATUS_COLORS: Record<SessionStatus, string> = {
	active: "bg-emerald-500",
	idle: "bg-amber-500",
	completed: "bg-slate-500",
	failed: "bg-red-500",
	archived: "bg-zinc-600",
};

export const SEMANTIC_STATUS_COLORS: Record<SemanticStatus, string> = {
	researching: "bg-blue-500",
	implementing: "bg-emerald-500",
	testing: "bg-purple-500",
	debugging: "bg-orange-500",
	reviewing: "bg-cyan-500",
	documenting: "bg-teal-500",
	planning: "bg-indigo-500",
	waiting: "bg-amber-500",
};

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
	claude_code: "Claude Code",
	codex_cli: "Codex CLI",
};

// Session is considered idle after this many minutes without events
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Session is considered ended after this many minutes without events
export const SESSION_END_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// WebSocket heartbeat interval
export const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds
