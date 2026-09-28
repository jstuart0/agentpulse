import type { AgentType, HookEventPayload } from "../../../shared/types.js";

/**
 * Turns a raw hook body into the canonical snake_case HookEventPayload shape
 * ingest.ts expects. `hint` is the `?event=` query param, present for
 * agents (Copilot) whose event name doesn't live in the body itself.
 *
 * Phase 1 seam only: both current agents (Claude, Codex) already post
 * canonical snake_case bodies, so their entries are identity. Phase 6 plugs
 * Copilot's camelCase-to-snake_case conversion in here without touching
 * ingest.ts or either existing entry.
 */
export type Canonicalizer = (raw: HookEventPayload, hint?: string) => HookEventPayload;

const identity: Canonicalizer = (raw) => raw;

export const HOOK_PAYLOAD_CANONICALIZERS: Record<AgentType, Canonicalizer> = {
	claude_code: identity,
	codex_cli: identity,
};

/**
 * Dispatch to the registered canonicalizer for `agentType`. Never throws —
 * ingest's always-200 contract can't afford a canonicalizer bug to take
 * hook ingestion down, so a canonicalizer error just falls back to the raw
 * body (the existing missing-fields check downstream still applies).
 */
export function canonicalizeHookPayload(
	agentType: AgentType,
	raw: HookEventPayload,
	hint?: string,
): HookEventPayload {
	const canonicalizer = HOOK_PAYLOAD_CANONICALIZERS[agentType];
	if (!canonicalizer) return raw;
	try {
		return canonicalizer(raw, hint);
	} catch {
		return raw;
	}
}
