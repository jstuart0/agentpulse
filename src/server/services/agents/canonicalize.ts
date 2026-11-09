import { parseOpenCodeEnvelope } from "../../../shared/opencode-wire.js";
import type { OpenCodeWireEnvelope, OpenCodeWireError } from "../../../shared/opencode-wire.js";
import {
	COPILOT_EVENT_TO_HOOK_EVENT,
	OPENCODE_EVENT_TO_HOOK_EVENT,
} from "../../../shared/types.js";
import type {
	AgentType,
	CopilotEvent,
	HookEventPayload,
	HookEventType,
} from "../../../shared/types.js";
import { sha256Hex } from "../util/hash.js";

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
// JSON.parse an oversized string) and what lands in the DB. OpenCode's
// canonicalizer (AGEN-141) caps with the same helpers and the same number.
const COPILOT_CAP_BYTES = 64 * 1024;

// F235 (Low, xander): provider_event_name can come from three untrusted
// sources — the body's own provider_event_name field, the `?event=` query
// hint, or the body's hook_event_name field — none of which had any size or
// content bound (unlike tool_input/tool_response, both capped above). Grepped
// providerEventType/provider_event_name under src/server/services/ai and
// src/server/services/ask (F235's second ask): nothing splices it into an
// LLM prompt today — ai/context.ts and ask/context-builder.ts both build
// their timeline from event.eventType (the canonical, small-enum type), not
// providerEventType — so this is a defense-in-depth cap on what lands in the
// DB and any future consumer, not a fix for an existing prompt-injection path.
const PROVIDER_EVENT_NAME_MAX = 128;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this strips control characters.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

function capProviderEventName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.replace(CONTROL_CHARS_RE, "").slice(0, PROVIDER_EVENT_NAME_MAX);
}

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
function capToolInput(value: Record<string, unknown>): Record<string, unknown> {
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
		if (isPlainObject(value)) return capToolInput(value);
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
	if (typeof response === "string") return capToolResponse(response);
	if (isPlainObject(response)) {
		const textResultForLlm = response.textResultForLlm;
		if (typeof textResultForLlm === "string") {
			return textResultForLlm.slice(0, COPILOT_CAP_BYTES);
		}
		// F220: a shape without textResultForLlm previously passed through
		// unbounded — cap it the same way toolArgs/tool_input does.
		return capToolResponse(response);
	}
	return response;
}

/** A tool response value held to COPILOT_CAP_BYTES: a string is cut, an object is cut by its JSON. */
function capToolResponse(
	value: string | Record<string, unknown>,
): string | Record<string, unknown> {
	return typeof value === "string" ? value.slice(0, COPILOT_CAP_BYTES) : capToolInput(value);
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
		provider_event_name: capProviderEventName(providerEventName),
		error_message: pickString(source, "error_message", "error"),
	};
	return out;
};

// ── OpenCode (AGEN-141) ─────────────────────────────────────────────────
//
// The body is an OpenCodeWireEnvelope (src/shared/opencode-wire.ts). The
// canonicalizer is total: it parses the body, builds a FRESH allow-listed
// payload from the parsed value (never the body), and answers the drop payload
// ({ session_id: "", hook_event_name: "" }, which ingest drops with a 200) for
// anything it can't or shouldn't store. It never spreads the body, so nothing
// the sender adds beyond the contract is stored.

const OPENCODE_DROP = (): HookEventPayload => ({ session_id: "", hook_event_name: "" });

// The compact tool_use_id limit (event-compact.ts): a child's id is the child
// session id plus the call id, which can be longer, so it is hashed past this.
const OPENCODE_CHILD_TOOL_USE_ID_MAX = 64;
const OPENCODE_CHILD_TOOL_USE_ID_HASH_CHARS = 24;
// OpenCode 1.x names a user abort MessageAbortedError (G13); 2.x reports the
// aborted step as type "aborted" and then session.execution.interrupted.
const OPENCODE_V1_ABORT_ERROR = "MessageAbortedError";
const OPENCODE_V2_ABORT_ERROR = "aborted";

export interface OpenCodeCanonicalizerDeps {
	capToolInput: typeof capToolInput;
	capToolResponse: typeof capToolResponse;
}

function openCodeErrorMessage(error: OpenCodeWireError | undefined): string | undefined {
	if (!error) return undefined;
	return error.status === undefined ? error.name : `${error.name} (HTTP ${error.status})`;
}

function openCodeToolUseId(toolUseId: string, childId: string | undefined): string {
	if (childId === undefined) return toolUseId;
	const composed = `${childId}:${toolUseId}`;
	// A child id of "approval" would build the server's reserved prefix (xander L1). The
	// registry turns this throw into the drop payload.
	if (composed.toLowerCase().startsWith("approval:")) {
		throw new Error("opencode tool_use_id uses the reserved approval: prefix");
	}
	if (composed.length <= OPENCODE_CHILD_TOOL_USE_ID_MAX) return composed;
	return `c:${sha256Hex(composed).slice(0, OPENCODE_CHILD_TOOL_USE_ID_HASH_CHARS)}`;
}

function openCodeToolFailed(data: { status: string; exit_code?: number }): boolean {
	return data.status === "error" || (data.exit_code !== undefined && data.exit_code !== 0);
}

function openCodeAbortError(env: OpenCodeWireEnvelope): boolean {
	if (env.hook_event_name === "session.error") {
		return env.data.error?.name === OPENCODE_V1_ABORT_ERROR;
	}
	return env.hook_event_name === "session.step.failed"
		? env.data.error?.name === OPENCODE_V2_ABORT_ERROR
		: false;
}

function openCodeCanonicalName(
	env: OpenCodeWireEnvelope,
	mapped: HookEventType,
	isChild: boolean,
): HookEventType | null {
	switch (env.hook_event_name) {
		case "session.created":
			return isChild ? "SubagentStart" : mapped;
		case "session.idle":
		case "session.execution.succeeded":
			return isChild ? "SubagentStop" : mapped;
		case "session.execution.failed":
			// A failed 2.x execution follows a session.step.failed (the error row); it ends the turn.
			return isChild ? "SubagentStop" : mapped;
		case "chat.message":
		case "session.inbox.enqueued":
			// A child's prompt is the parent's own tool input, not a user turn.
			return isChild || env.data.text.length === 0 ? null : mapped;
		case "tool.execute.after":
		case "tool.after":
			return openCodeToolFailed(env.data) ? "PostToolUseFailure" : mapped;
		case "permission.replied":
			// Only a reject is a signal. Any other reply lets the tool run, and its Post clears the wait.
			return env.data.reply === "reject" ? mapped : null;
		case "session.error":
			// A user abort of the root is an Interrupt; a child's abort is just its error row.
			return !isChild && openCodeAbortError(env) ? "Interrupt" : mapped;
		case "session.step.failed":
			// The 2.x abort is reported by session.execution.interrupted; its aborted step adds nothing.
			return openCodeAbortError(env) ? null : mapped;
		case "session.execution.interrupted":
			return isChild ? null : mapped;
		default:
			return mapped;
	}
}

function buildOpenCodePayload(
	env: OpenCodeWireEnvelope,
	deps: OpenCodeCanonicalizerDeps,
): HookEventPayload {
	const table: Record<string, HookEventType> = OPENCODE_TABLES[env.opencode.line];
	const mapped = table[env.hook_event_name];
	if (!mapped) return OPENCODE_DROP();
	const childId = env.parent_session_id === undefined ? undefined : env.session_id;
	const canonical = openCodeCanonicalName(env, mapped, childId !== undefined);
	if (canonical === null) return OPENCODE_DROP();

	const out: HookEventPayload = {
		session_id: env.parent_session_id ?? env.session_id,
		hook_event_name: canonical,
		provider_event_name: capProviderEventName(env.hook_event_name),
		opencode: { ...env.opencode },
	};
	// A child's cwd, model and final text are not the parent's: carried over, they would
	// overwrite the parent's directory and model and turn the child's last answer into an
	// AssistantMessage on the parent (ian L5). The relay and the plugin judge the child's
	// directory before the envelope is sent; the server stores none of it.
	if (childId === undefined) {
		if (env.cwd !== undefined) out.cwd = env.cwd;
		if (env.model !== undefined) out.model = env.model;
	} else {
		out.agent_id = childId;
		out.parent_session_id = env.parent_session_id;
	}
	if (childId === undefined && env.last_assistant_message !== undefined && canonical === "Stop") {
		out.last_assistant_message = env.last_assistant_message;
	}

	switch (env.hook_event_name) {
		case "chat.message":
		case "session.inbox.enqueued":
			out.prompt = env.data.text;
			break;
		case "tool.execute.before":
		case "tool.before":
			out.tool_name = env.data.tool;
			out.tool_input = deps.capToolInput(env.data.input);
			out.tool_use_id = openCodeToolUseId(env.data.tool_use_id, childId);
			break;
		case "tool.execute.after":
		case "tool.after": {
			out.tool_name = env.data.tool;
			out.tool_input = deps.capToolInput(env.data.input);
			out.tool_use_id = openCodeToolUseId(env.data.tool_use_id, childId);
			// An error status carries no output: a provider or tool error text can echo request
			// material (xander L4). The plugin sends none either; this holds if a sender does.
			const output =
				env.data.output === undefined || env.data.status === "error" ? "" : env.data.output;
			if (env.data.exit_code !== undefined) {
				out.tool_response = deps.capToolResponse({ output, exit_code: env.data.exit_code });
			} else if (env.data.output !== undefined && env.data.status !== "error") {
				out.tool_response = deps.capToolResponse(output);
			}
			if (canonical === "PostToolUseFailure") {
				out.error_message = openCodeErrorMessage(env.data.error);
			}
			break;
		}
		case "permission.asked":
			out.tool_name = env.data.permission;
			out.tool_input = deps.capToolInput({ patterns: env.data.patterns ?? [] });
			out.tool_use_id = openCodeToolUseId(env.data.tool_use_id, childId);
			break;
		case "permission.replied":
			out.tool_use_id = openCodeToolUseId(env.data.tool_use_id, childId);
			break;
		case "session.error":
		case "session.step.failed":
		case "session.execution.failed":
			// The failure is the error row's; a 2.x execution.failed that ends the turn is a plain Stop.
			if (canonical === "ErrorOccurred") out.error_message = openCodeErrorMessage(env.data.error);
			break;
		default:
			break;
	}
	return out;
}

const OPENCODE_TABLES = OPENCODE_EVENT_TO_HOOK_EVENT;

/** Built with injectable cap helpers so a test can force the "canonicalizer threw" path. */
export function createOpenCodeCanonicalizer(deps: OpenCodeCanonicalizerDeps): Canonicalizer {
	return (raw) => {
		const envelope = parseOpenCodeEnvelope(raw);
		return envelope ? buildOpenCodePayload(envelope, deps) : OPENCODE_DROP();
	};
}

const opencodeCanonicalizer = createOpenCodeCanonicalizer({ capToolInput, capToolResponse });

export const HOOK_PAYLOAD_CANONICALIZERS: Record<AgentType, Canonicalizer> = {
	claude_code: identity,
	codex_cli: identity,
	copilot_cli: copilotCanonicalizer,
	opencode: opencodeCanonicalizer,
};

/**
 * What `canonicalizeHookPayload` answers when an agent's canonicalizer throws.
 * "raw" keeps the body (the agents whose bodies are already canonical);
 * "drop" answers the drop payload, because for OpenCode the raw body is
 * untrusted sender data that must never be stored as the row's payload.
 */
const CANONICALIZER_FAILURE: Record<AgentType, "raw" | "drop"> = {
	claude_code: "raw",
	codex_cli: "raw",
	copilot_cli: "raw",
	opencode: "drop",
};

/**
 * Dispatch to the registered canonicalizer for `agentType`. Never throws —
 * ingest's always-200 contract can't afford a canonicalizer bug to take
 * hook ingestion down, so a canonicalizer error falls back per
 * CANONICALIZER_FAILURE: the raw body for the agents whose bodies are already
 * canonical (the existing missing-fields check downstream still applies), the
 * drop payload for OpenCode.
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
		return CANONICALIZER_FAILURE[agentType] === "drop" ? OPENCODE_DROP() : raw;
	}
}
