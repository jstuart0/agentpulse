/**
 * The subagent half of a fork's tool policy (AGEN-120). Track 0 reserves the seam: every function reports
 * "off". AGEN-120 owns this file and fills the bodies.
 */
import type { AppliedForkOptions, ForkOptionsRequest } from "../../shared/session-resume.js";
import type { ForkOptionsContext, ForkPolicyPart, PreparedPart } from "./claude-fork-tools.js";

/** What the policy contributes when subagents are applied. Null: nothing. */
export function subagentPolicyPart(_applied: AppliedForkOptions): ForkPolicyPart | null {
	return null;
}

/** Whether `toolName` is the Agent call. Null: not applied. */
export function subagentToolKind(_toolName: string, _applied: AppliedForkOptions): "agent" | null {
	return null;
}

/** Applies subagents when the request asks and the measured gates hold. Null: nothing applied. */
export async function prepareSubagents(
	_request: ForkOptionsRequest,
	_ctx: ForkOptionsContext,
): Promise<PreparedPart | null> {
	return null;
}
