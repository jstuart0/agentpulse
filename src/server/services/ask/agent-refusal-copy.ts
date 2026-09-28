import { AGENT_METADATA } from "../../../shared/constants.js";
import type { AgentType } from "../../../shared/types.js";

/**
 * Shared copy for every place Ask refuses to launch/resume a non-launchable
 * agent type (D5 Pattern A'). One source of truth so ask-resume-handler,
 * launch-intent-detector and launch-disambiguation-handler can't drift.
 *
 * "copilot_cli" isn't registered in AGENT_METADATA until Phase 6 (D5's
 * honest note — Phase 1 keeps AGENT_TYPES and LAUNCHABLE_AGENT_TYPES
 * identical), so it's the one hardcoded fallback here. Once Phase 6 adds
 * it to AGENT_METADATA, the `agentType in AGENT_METADATA` branch below
 * takes over and this fallback stops being reachable.
 */
function agentLabel(agentType: string): string {
	if (agentType in AGENT_METADATA) return AGENT_METADATA[agentType as AgentType].label;
	if (agentType === "copilot_cli") return "Copilot CLI";
	// Never echo arbitrary classifier-supplied text back into a user-facing
	// reply (F71, xander mid-build) — this string came from LLM JSON output,
	// not a validated allowlist, so it could be long, control-character-laden,
	// or an attempted prompt-injection payload. A generic, length-capped
	// label instead of the raw value.
	return "that agent";
}

/** Used by ask-resume-handler and launch-intent-detector's resume-intent parsing. */
export function resumeRefusalCopy(agentType: string): string {
	return `Resume isn't supported for ${agentLabel(agentType)} sessions — AgentPulse can only launch Claude Code or Codex.`;
}

/** Used by launch-intent-detector's launch-intent parsing and launch-disambiguation-handler. */
export function launchRefusalCopy(agentType: string): string {
	return `${agentLabel(agentType)} can't be launched — AgentPulse can only launch Claude Code or Codex.`;
}
