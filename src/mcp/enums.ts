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

export const AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli"]);
export const SESSION_STATUS_ENUM = z.enum(["active", "idle", "completed", "failed", "archived"]);

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
