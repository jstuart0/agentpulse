import { AGENT_TYPES } from "../../shared/constants.js";
import type { AgentType } from "../../shared/types.js";

/**
 * Typed error thrown when a query-string agent-type filter (`agent_type` /
 * `agentType`) carries a value outside `AGENT_TYPES` (AGEN-44). Before this,
 * routes silently cast the raw query string to `AgentType` and passed it
 * straight to a `WHERE agent_type = ?` clause, so an unknown value (e.g. a
 * newer client's agent type this server doesn't know about) matched zero
 * rows instead of surfacing as an error.
 */
export class InvalidAgentTypeQueryError extends Error {
	readonly value: string;
	constructor(value: string) {
		super(`Invalid agent_type: "${value}". Allowed: ${AGENT_TYPES.join(", ")}`);
		this.name = "InvalidAgentTypeQueryError";
		this.value = value;
	}
}

/**
 * Parses an `agent_type`/`agentType` query-string value. An absent or empty
 * value returns `undefined` (no filter — unchanged behavior). A non-empty
 * value outside `AGENT_TYPES` throws `InvalidAgentTypeQueryError`; callers
 * should catch it and respond `400 { error: "invalid_agent_type", value,
 * allowed: AGENT_TYPES }`.
 */
export function parseAgentTypeQuery(raw: string | undefined): AgentType | undefined {
	if (!raw) return undefined;
	if (!AGENT_TYPES.includes(raw as AgentType)) {
		throw new InvalidAgentTypeQueryError(raw);
	}
	return raw as AgentType;
}
