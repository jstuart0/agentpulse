/**
 * Shared zod enums for MCP tool input schemas (AGEN-12 Phase 3 mid-build
 * consolidation, dexter Low).
 *
 * Mirrors src/shared/constants.ts's AGENT_TYPES/SESSION_STATUSES tuples.
 * Spelled as literal zod enums (rather than z.enum(AGENT_TYPES)) because
 * zod's enum() wants a mutable string tuple and the shared consts are
 * `as const` readonly — duplicating the literal values here is simpler than
 * fighting the tuple variance. Keep in sync if either list changes.
 */
import { z } from "zod";

export const AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli"]);
export const SESSION_STATUS_ENUM = z.enum(["active", "idle", "completed", "failed", "archived"]);
