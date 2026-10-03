/**
 * Shared zod enums for MCP tool input schemas (AGEN-12 Phase 3 mid-build
 * consolidation, dexter Low; extended Phase 4 for the orchestration tools).
 *
 * Mirrors src/shared/constants.ts's / src/shared/types.ts's tuples.
 * Spelled as literal zod enums (rather than z.enum(AGENT_TYPES)) because
 * zod's enum() wants a mutable string tuple and the shared consts are
 * `as const` readonly — duplicating the literal values here is simpler than
 * fighting the tuple variance. Keep in sync if either list changes.
 */
import { z } from "zod";

// Split per D5 (2026-09-28-deliver-agent-cli-parity): OBSERVED covers every
// agent type that can post hook events and appear on the dashboard;
// LAUNCHABLE covers only what AgentPulse can actively start a process for.
// Phase 6: "copilot_cli" is observe-only (D5/F23) — added to OBSERVED only.
export const OBSERVED_AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli", "copilot_cli"]);
export const LAUNCHABLE_AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli"]);
export const SESSION_STATUS_ENUM = z.enum(["active", "idle", "completed", "failed", "archived"]);

// Mirrors src/shared/session-state.ts's ACTIVE_OPERATIONAL_STATUSES — the
// derived operational state (distinct from the lifecycle SESSION_STATUS_ENUM
// above), computed server-side from turn/acknowledgement/permission-wait
// timing rather than stored directly.
export const OPERATIONAL_STATUS_ENUM = z.enum(["waiting", "error", "working", "idle"]);

// Phase 4: mirrors src/shared/types.ts's LaunchMode/LaunchRoutingPolicy/
// ApprovalPolicy/SandboxMode/HitlReplyKind/ActionRequestDecision unions.
export const LAUNCH_MODE_ENUM = z.enum(["interactive_terminal", "headless", "managed_codex"]);
export const ROUTING_POLICY_ENUM = z.enum(["manual_target", "first_capable_host"]);
export const APPROVAL_POLICY_ENUM = z.enum([
	"default",
	"suggest",
	"auto",
	"manual",
	"untrusted",
	"on-failure",
]);
export const SANDBOX_MODE_ENUM = z.enum([
	"default",
	"workspace-write",
	"read-only",
	"danger-full-access",
]);
export const HITL_REPLY_KIND_ENUM = z.enum(["approve", "decline", "custom"]);
export const ACTION_REQUEST_DECISION_ENUM = z.enum(["applied", "declined"]);

/**
 * The `owner` filter on list_sessions and get_stats: `me`, `all`,
 * `unassigned`, `service`, or a user id (a UUID). Mirrors the grammar in
 * src/shared/owner-scope.ts, spelled out here because this package can't
 * import from src/shared. One flat string with a pattern, not a union, so the
 * tool schema stays a plain object property.
 */
export const OWNER_SCOPE_PATTERN =
	/^(?:me|all|unassigned|service|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
export const OWNER_SCOPE = z
	.string()
	.regex(OWNER_SCOPE_PATTERN, "owner must be me, all, unassigned, service, or a user id");
