/**
 * The MCP half of a fork's tool policy (AGEN-121). Track 0 reserves the seam: every function reports "off".
 * AGEN-121 owns this file and fills the bodies; nothing outside it edits `claude-stream.ts`, `claude-argv.ts`
 * or `claude-fork-tools.ts` to make MCP work.
 */
import type { AppliedForkOptions, ForkOptionsRequest } from "../../shared/session-resume.js";
import type { ForkOptionsContext, ForkPolicyPart, PreparedPart } from "./claude-fork-tools.js";

/** What the policy contributes for the MCP servers `applied` names. Null: nothing. */
export function mcpPolicyPart(_applied: AppliedForkOptions): ForkPolicyPart | null {
	return null;
}

/** Whether `toolName` is an MCP tool of an applied server. Null: not one. */
export function mcpToolKind(_toolName: string, _applied: AppliedForkOptions): "mcp" | null {
	return null;
}

/** Reads the person's MCP file and writes the private `--mcp-config` copy, when the request asks for MCP. Null: nothing applied. */
export async function prepareMcp(
	_request: ForkOptionsRequest,
	_ctx: ForkOptionsContext,
): Promise<PreparedPart | null> {
	return null;
}
