import { COPILOT_EVENT_TO_HOOK_EVENT } from "../../../shared/types.js";
import type { AgentType, CopilotEvent, HookEventPayload } from "../../../shared/types.js";

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

// D7/F28: Copilot posts a 1 MiB+ toolArgs string in the worst case (a large
// file read/diff); this cap protects both the canonicalizer itself (never
// JSON.parse an oversized string) and what lands in the DB.
const COPILOT_CAP_BYTES = 64 * 1024;

type LooseRecord = Record<string, unknown>;

function pickString(raw: LooseRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

// F220 (Low): an already-parsed object (toolArgs/tool_input arriving as an
// object rather than a JSON string, or a toolResponse without
// textResultForLlm) can still be oversized — cap it the same way, with the
// same {raw, truncated} marker the string branch already uses. Scoped to
// plain objects only: null/array/number are tolerated as-is elsewhere
// (Copilot's shape is unverified — see normalizeToolInput's docstring), and
// arrays large enough to matter are not the case this finding named.
function capObjectIfOversized(value: Record<string, unknown>): Record<string, unknown> {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return value;
	}
	if (serialized.length <= COPILOT_CAP_BYTES) return value;
	return { raw: serialized.slice(0, COPILOT_CAP_BYTES), truncated: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * F28/F30: normalizes a `toolArgs`/`tool_input` value into HookEventPayload's
 * tool_input shape.
 * - undefined -> undefined (field never posted)
 * - "" -> {raw: ""} (the ??-boundary case — an explicit "no args", not the
 *   same as "field absent")
 * - a string over COPILOT_CAP_BYTES -> {raw: first COPILOT_CAP_BYTES,
 *   truncated: true}, NEVER parsed (parsing a 1 MiB string before
 *   truncating would defeat the point of the cap)
 * - a string at or under the cap -> JSON.parse()'d, or {raw: string} if it
 *   isn't valid JSON
 * - an already-parsed object over the cap (F220) -> {raw: first
 *   COPILOT_CAP_BYTES of its JSON serialization, truncated: true}
 * - null / an array / a number / an object at or under the cap -> returned
 *   unchanged (Copilot's toolArgs shape is unverified against the real CLI,
 *   SPIKE.md fact 2 — tolerate whatever shape arrives rather than coercing)
 */
function normalizeToolInput(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		if (isPlainObject(value)) return capObjectIfOversized(value);
		return value as Record<string, unknown>;
	}
	if (value === "") return { raw: "" };
	if (value.length > COPILOT_CAP_BYTES) {
		return { raw: value.slice(0, COPILOT_CAP_BYTES), truncated: true };
	}
	try {
		return JSON.parse(value);
	} catch {
		return { raw: value };
	}
}

/**
 * F28: the tool's response/result text, capped at COPILOT_CAP_BYTES before
 * assignment. Tolerates both the fixture-confirmed shape (a plain
 * `toolResponse` string) and the docs-described `toolResult.textResultForLlm`
 * shape (SPIKE.md fact 1/2 — Copilot's real shape is unverified).
 */
function normalizeToolResponse(raw: LooseRecord): unknown {
	const response = raw.toolResponse ?? raw.tool_response ?? raw.toolResult;
	if (typeof response === "string") return response.slice(0, COPILOT_CAP_BYTES);
	if (isPlainObject(response)) {
		const textResultForLlm = response.textResultForLlm;
		if (typeof textResultForLlm === "string") {
			return textResultForLlm.slice(0, COPILOT_CAP_BYTES);
		}
		// F220: a shape without textResultForLlm previously passed through
		// unbounded — cap it the same way toolArgs/tool_input does.
		return capObjectIfOversized(response);
	}
	return response;
}

// F221 (xander, Medium): `value in COPILOT_EVENT_TO_HOOK_EVENT` walks the
// prototype chain, so `?event=constructor` (or __proto__/toString/
// hasOwnProperty) resolves to an inherited Object.prototype member instead
// of "no mapping". Object.hasOwn checks only the object's own properties.
function isCopilotEvent(value: string | undefined): value is CopilotEvent {
	return value !== undefined && Object.hasOwn(COPILOT_EVENT_TO_HOOK_EVENT, value);
}

/**
 * D7: Copilot posts a dual shape — its native camelCase fields (sessionId,
 * toolName, toolArgs, toolResponse, no event-name field in the body at all;
 * the event arrives via the `?event=` query param instead) and, per the
 * docs, a Pascal/snake_case mirror carrying hook_event_name directly
 * (matching Claude/Codex's own convention). This reads either shape and
 * always emits the canonical snake_case one.
 */
const copilotCanonicalizer: Canonicalizer = (raw, hint) => {
	const source = raw as unknown as LooseRecord;
	const sessionId = pickString(source, "session_id", "sessionId") ?? "";
	const cwd = pickString(source, "cwd");
	const payloadEventName = pickString(source, "hook_event_name");
	const providerEventName = pickString(source, "provider_event_name") ?? hint ?? payloadEventName;
	const hookEventName =
		payloadEventName ?? (isCopilotEvent(hint) ? COPILOT_EVENT_TO_HOOK_EVENT[hint] : "") ?? "";

	const out: HookEventPayload = {
		session_id: sessionId,
		hook_event_name: hookEventName,
		cwd,
		tool_name: pickString(source, "tool_name", "toolName"),
		tool_input: normalizeToolInput(source.tool_input ?? source.toolArgs),
		tool_response: normalizeToolResponse(source),
		prompt: pickString(source, "prompt"),
		trigger: pickString(source, "trigger"),
		// D7: subagentStart/subagentStop's Copilot-native id, mapped onto the
		// same field Claude's SubagentStart/Stop already use.
		agent_id: pickString(source, "agent_id", "subagentId"),
		// SessionEnd/agentStop's Copilot-native "why did this session end"
		// string — no dedicated HookEventPayload field for it, so it's
		// surfaced via `message` (already used for Notification's freeform
		// text) rather than inventing a new one outside this phase's scope.
		message: pickString(source, "message", "reason"),
		provider_event_name: providerEventName,
		error_message: pickString(source, "error_message", "error"),
	};
	return out;
};

export const HOOK_PAYLOAD_CANONICALIZERS: Record<AgentType, Canonicalizer> = {
	claude_code: identity,
	codex_cli: identity,
	copilot_cli: copilotCanonicalizer,
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
