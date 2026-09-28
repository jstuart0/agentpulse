// IMPORTANT: these `as const` tuples are the single source of truth for
// the matching string-literal-union types in shared/types.ts. Do NOT
// edit one without the other — adding a new value here automatically
// widens the type, but tightening Record<KindName, V> maps below will
// fail to compile until every consumer adds the new key.
import type { AgentType, LaunchableAgentType, SemanticStatus, SessionStatus } from "./types.js";

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

// SLICE-G: 'archived' is retained for backwards-compat with rows that pre-date
// the isArchived boolean. New code never writes this value as an archive signal;
// see src/shared/session-state.ts (isVisibleSession / isArchivedSession) for the
// canonical predicate. Plan to remove in the follow-up slice that reworks the
// search backend's sessionStatus filter (clarity-slice-h-archive-status-removal).
export const SESSION_STATUSES = ["active", "idle", "completed", "failed", "archived"] as const;

export const AGENT_TYPES = ["claude_code", "codex_cli"] as const;

// Agent types AgentPulse can actively start a process for. Everything in
// AGENT_TYPES that isn't here is observed-only (D5): it can post hook
// events and show up on the dashboard, but no launch/template/resume path
// may accept it as a target. Phase 1 keeps this identical to AGENT_TYPES;
// Phase 6 adds "copilot_cli" to AGENT_TYPES without adding it here, which is
// the whole point of the split.
export const LAUNCHABLE_AGENT_TYPES = ["claude_code", "codex_cli"] as const;

export function isLaunchable(agentType: string): agentType is LaunchableAgentType {
	return (LAUNCHABLE_AGENT_TYPES as readonly string[]).includes(agentType);
}

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

export interface AgentMetadata {
	label: string;
	shortLabel: string;
	badgeClass: string;
	dotClass: string;
	instructionsFile: "CLAUDE.md" | "AGENTS.md";
	/** null when the agent has no observed-only caveat to show in the UI. */
	observeOnlyHint: string | null;
	/** Whether this agent's CLI can report its own native session/thread name back to AgentPulse (D14). */
	hasNameSource: boolean;
}

export const AGENT_METADATA: Record<AgentType, AgentMetadata> = {
	claude_code: {
		label: "Claude Code",
		shortLabel: "Claude",
		badgeClass: "bg-orange-500/8 text-orange-400/90 border-orange-500/15",
		dotClass: "bg-orange-400/70",
		instructionsFile: "CLAUDE.md",
		observeOnlyHint: null,
		hasNameSource: true,
	},
	codex_cli: {
		label: "Codex CLI",
		shortLabel: "Codex",
		badgeClass: "bg-green-500/8 text-green-400/90 border-green-500/15",
		dotClass: "bg-green-400/70",
		instructionsFile: "AGENTS.md",
		observeOnlyHint: null,
		hasNameSource: true,
	},
};

export const AGENT_TYPE_LABELS: Record<AgentType, string> = Object.fromEntries(
	(AGENT_TYPES as readonly AgentType[]).map((t) => [t, AGENT_METADATA[t].label]),
) as Record<AgentType, string>;

// Session is considered idle after this many minutes without events
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Session is considered ended after this many minutes without events
export const SESSION_END_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// WebSocket heartbeat interval
export const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds
