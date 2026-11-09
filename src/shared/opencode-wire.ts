/**
 * The OpenCode wire contract (AGEN-141, P2). The plugin for each OpenCode line
 * posts one envelope per forwarded event to `/api/v1/hooks` with
 * `X-Agent-Type: opencode`. The envelope is named by OpenCode's own event name
 * and the server maps it, so a change in OpenCode is fixed by a server deploy.
 *
 *   { session_id, hook_event_name: "<native name>",
 *     opencode: { line: 1 | 2, protocol: 1, version? },
 *     cwd?, parent_session_id? (child sessions), model?,
 *     last_assistant_message? (turn ends), data: <per event> }
 *
 * `session_id` and `cwd` are top level because the relay judges exclusion
 * from them. There is no `turn_id`: OpenCode exposes no per-turn id on either
 * line (gate G10), so order rests on the plugin's per-session send chain.
 * `data` never carries error headers, bodies or messages (P11): an error is
 * its name and an optional HTTP status.
 *
 * Everything here treats the body as hostile. `parseOpenCodeEnvelope` returns
 * a fresh, validated copy (it never hands back or spreads the input) or null.
 * The plugin tests validate every POST body with this same parser, and the
 * server's canonicalizer consumes only its output.
 */

import { OPENCODE_EVENT_TO_HOOK_EVENT } from "./types.js";
import type { OpenCodeV1Event, OpenCodeV2Event } from "./types.js";

export const OPENCODE_WIRE_PROTOCOL = 1 as const;

/** The longest any single string field may be, by `String.length` (the plugin caps at the same number). */
export const OPENCODE_STRING_CAP = 64 * 1024;
/** `session_id`, `parent_session_id`: 1 to this many characters of `[A-Za-z0-9_-]`. */
export const OPENCODE_ID_MAX = 128;
/** The longest `tool_use_id` the plugin may send (the server's dedup limit is the same number). */
export const OPENCODE_TOOL_USE_ID_MAX = 200;
export const OPENCODE_ERROR_NAME_MAX = 64;
export const OPENCODE_MODEL_MAX = 256;
export const OPENCODE_VERSION_MAX = 64;
export const OPENCODE_CWD_MAX = 4096;
const TOOL_NAME_MAX = 128;
const PERMISSION_NAME_MAX = 128;
const PATTERN_MAX_COUNT = 32;
const PATTERN_MAX_CHARS = 1024;
const REPLY_MAX = 32;
// A tool's arguments are arbitrary JSON; bound what the walk will look at.
const INPUT_MAX_DEPTH = 12;
const INPUT_MAX_NODES = 20_000;

const ID_RE = /^[A-Za-z0-9_-]+$/;
const ERROR_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const REPLY_RE = /^[a-z_-]+$/;
const CONTROL_RE = /\p{Cc}/u;
const FALLBACK_ERROR_NAME = "Error";
/**
 * The only error names that cross the wire as themselves: the ones seen in the
 * Phase 0 captures. A name is provider-influenced text, so anything else is
 * folded to "Error" (xander L3). Add a name only with a capture that shows it.
 */
export const OPENCODE_KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
	"Error",
	"APIError",
	"Tool.Error",
	"MessageAbortedError",
	"aborted",
	"provider.invalid-request",
]);
/** The server reserves this prefix for its own approval waits (event-processor). */
const RESERVED_TOOL_USE_ID_PREFIX = "approval:";

export interface OpenCodeWireError {
	/** `^[A-Za-z0-9_.-]+$`, at most 64 characters; anything else arrives as "Error". */
	name: string;
	/** The HTTP status of a provider error, 100 to 599. */
	status?: number;
}

export interface OpenCodeToolStartData {
	tool: string;
	/** The call id with the plugin's reuse suffix (`<callID>#<n>`, n from 2). */
	tool_use_id: string;
	input: Record<string, unknown>;
}

export interface OpenCodeToolEndData extends OpenCodeToolStartData {
	status: "completed" | "error";
	/** A shell tool's exit code, when the tool reports one. */
	exit_code?: number;
	output?: string;
	error?: OpenCodeWireError;
}

export interface OpenCodePromptData {
	text: string;
}

export type OpenCodeNoData = Record<string, never>;

export interface OpenCodeErrorData {
	error?: OpenCodeWireError;
}

export interface OpenCodePermissionAskedData {
	/** OpenCode's permission request id (`per_...`). */
	request_id: string;
	/** The call the request is for (`<callID>#<n>`), or `perm:<request_id>` when OpenCode named none. */
	tool_use_id: string;
	permission: string;
	patterns?: string[];
}

export interface OpenCodePermissionRepliedData {
	request_id: string;
	tool_use_id: string;
	/** `once`, `always` or `reject`. */
	reply: string;
}

interface OpenCodeV1DataMap {
	"session.created": OpenCodeNoData;
	"chat.message": OpenCodePromptData;
	"tool.execute.before": OpenCodeToolStartData;
	"tool.execute.after": OpenCodeToolEndData;
	"permission.asked": OpenCodePermissionAskedData;
	"permission.replied": OpenCodePermissionRepliedData;
	"session.error": OpenCodeErrorData;
	"session.idle": OpenCodeNoData;
}

interface OpenCodeV2DataMap {
	"session.created": OpenCodeNoData;
	"session.inbox.enqueued": OpenCodePromptData;
	"tool.before": OpenCodeToolStartData;
	"tool.after": OpenCodeToolEndData;
	"permission.asked": OpenCodePermissionAskedData;
	"permission.replied": OpenCodePermissionRepliedData;
	"session.step.failed": OpenCodeErrorData;
	"session.execution.succeeded": OpenCodeNoData;
	"session.execution.failed": OpenCodeErrorData;
	"session.execution.interrupted": OpenCodeNoData;
}

export interface OpenCodeWireInfo<Line extends 1 | 2 = 1 | 2> {
	line: Line;
	protocol: typeof OPENCODE_WIRE_PROTOCOL;
	version?: string;
}

interface OpenCodeEnvelopeBase {
	session_id: string;
	cwd?: string;
	parent_session_id?: string;
	model?: string;
	last_assistant_message?: string;
}

export type OpenCodeWireEnvelope =
	| {
			[K in OpenCodeV1Event]: OpenCodeEnvelopeBase & {
				opencode: OpenCodeWireInfo<1>;
				hook_event_name: K;
				data: OpenCodeV1DataMap[K];
			};
	  }[OpenCodeV1Event]
	| {
			[K in OpenCodeV2Event]: OpenCodeEnvelopeBase & {
				opencode: OpenCodeWireInfo<2>;
				hook_event_name: K;
				data: OpenCodeV2DataMap[K];
			};
	  }[OpenCodeV2Event];

type DataShape =
	| "none"
	| "prompt"
	| "toolStart"
	| "toolEnd"
	| "permAsked"
	| "permReplied"
	| "error";

const V1_SHAPES: Record<OpenCodeV1Event, DataShape> = {
	"session.created": "none",
	"chat.message": "prompt",
	"tool.execute.before": "toolStart",
	"tool.execute.after": "toolEnd",
	"permission.asked": "permAsked",
	"permission.replied": "permReplied",
	"session.error": "error",
	"session.idle": "none",
};

const V2_SHAPES: Record<OpenCodeV2Event, DataShape> = {
	"session.created": "none",
	"session.inbox.enqueued": "prompt",
	"tool.before": "toolStart",
	"tool.after": "toolEnd",
	"permission.asked": "permAsked",
	"permission.replied": "permReplied",
	"session.step.failed": "error",
	"session.execution.succeeded": "none",
	"session.execution.failed": "error",
	"session.execution.interrupted": "none",
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A record is only usable if it has no own `__proto__` key (JSON.parse creates one as plain data). */
function isCleanObj(value: unknown): value is Obj {
	return isObj(value) && !Object.hasOwn(value, "__proto__");
}

function idOf(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > OPENCODE_ID_MAX)
		return null;
	return ID_RE.test(value) ? value : null;
}

function plainString(value: unknown, max: number): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
	return CONTROL_RE.test(value) ? null : value;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.length <= OPENCODE_STRING_CAP ? value : null;
}

function toolUseIdOf(value: unknown): string | null {
	const id = plainString(value, OPENCODE_TOOL_USE_ID_MAX);
	return id === null || id.toLowerCase().startsWith(RESERVED_TOOL_USE_ID_PREFIX) ? null : id;
}

function errorOf(value: unknown): OpenCodeWireError | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (!isCleanObj(value)) return null;
	const rawName = value.name;
	const name =
		typeof rawName === "string" &&
		rawName.length <= OPENCODE_ERROR_NAME_MAX &&
		ERROR_NAME_RE.test(rawName) &&
		OPENCODE_KNOWN_ERROR_NAMES.has(rawName)
			? rawName
			: FALLBACK_ERROR_NAME;
	const status = value.status;
	const out: OpenCodeWireError = { name };
	if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
		out.status = status;
	}
	return out;
}

const FAIL = Symbol("opencode-wire-fail");

/** Deep copy of JSON-safe tool arguments, or null if the value breaks a bound. */
function cloneInput(value: unknown, depth: number, budget: { nodes: number }): unknown {
	budget.nodes += 1;
	if (budget.nodes > INPUT_MAX_NODES || depth > INPUT_MAX_DEPTH) return FAIL;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : FAIL;
	if (typeof value === "string") return value.length <= OPENCODE_STRING_CAP ? value : FAIL;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) {
			const copy = cloneInput(item, depth + 1, budget);
			if (copy === FAIL) return FAIL;
			out.push(copy);
		}
		return out;
	}
	if (isCleanObj(value)) {
		const out: Obj = {};
		for (const key of Object.keys(value)) {
			const copy = cloneInput(value[key], depth + 1, budget);
			if (copy === FAIL) return FAIL;
			out[key] = copy;
		}
		return out;
	}
	return FAIL;
}

function inputOf(value: unknown): Obj | null {
	if (!isCleanObj(value)) return null;
	const copy = cloneInput(value, 0, { nodes: 0 });
	return copy === FAIL ? null : (copy as Obj);
}

function toolStartOf(data: Obj): OpenCodeToolStartData | null {
	const tool = plainString(data.tool, TOOL_NAME_MAX);
	const toolUseId = toolUseIdOf(data.tool_use_id);
	const input = inputOf(data.input);
	if (!tool || !toolUseId || !input) return null;
	return { tool, tool_use_id: toolUseId, input };
}

function toolEndOf(data: Obj): OpenCodeToolEndData | null {
	const start = toolStartOf(data);
	if (!start) return null;
	const status = data.status;
	if (status !== "completed" && status !== "error") return null;
	const out: OpenCodeToolEndData = { ...start, status };
	const exit = data.exit_code;
	if (exit !== undefined && exit !== null) {
		if (typeof exit !== "number" || !Number.isInteger(exit) || Math.abs(exit) > 2 ** 31)
			return null;
		out.exit_code = exit;
	}
	if (data.output !== undefined) {
		const output = textOf(data.output);
		if (output === null) return null;
		out.output = output;
	}
	const error = errorOf(data.error);
	if (error === null) return null;
	if (error) out.error = error;
	return out;
}

function dataOf(shape: DataShape, data: Obj): OpenCodeWireEnvelope["data"] | null {
	switch (shape) {
		case "none":
			return {};
		case "prompt": {
			const text = textOf(data.text);
			return text === null ? null : { text };
		}
		case "toolStart":
			return toolStartOf(data);
		case "toolEnd":
			return toolEndOf(data);
		case "error": {
			const error = errorOf(data.error);
			if (error === null) return null;
			return error ? { error } : {};
		}
		case "permAsked": {
			const requestId = toolUseIdOf(data.request_id);
			const toolUseId = toolUseIdOf(data.tool_use_id);
			const permission = plainString(data.permission, PERMISSION_NAME_MAX);
			if (!requestId || !toolUseId || !permission) return null;
			const out: OpenCodePermissionAskedData = {
				request_id: requestId,
				tool_use_id: toolUseId,
				permission,
			};
			if (data.patterns !== undefined) {
				if (!Array.isArray(data.patterns) || data.patterns.length > PATTERN_MAX_COUNT) return null;
				const patterns: string[] = [];
				for (const p of data.patterns) {
					if (typeof p !== "string" || p.length > PATTERN_MAX_CHARS) return null;
					patterns.push(p);
				}
				out.patterns = patterns;
			}
			return out;
		}
		case "permReplied": {
			const requestId = toolUseIdOf(data.request_id);
			const toolUseId = toolUseIdOf(data.tool_use_id);
			const reply = data.reply;
			if (!requestId || !toolUseId) return null;
			if (typeof reply !== "string" || reply.length > REPLY_MAX || !REPLY_RE.test(reply))
				return null;
			return { request_id: requestId, tool_use_id: toolUseId, reply };
		}
	}
}

/**
 * Validate an untrusted body as an OpenCode envelope. Returns a fresh copy of
 * exactly the fields the contract names, or null for anything else: a wrong
 * type, an unknown event for the line, a protocol other than 1, an id that
 * breaks P11's rules, a string over 64 KiB, an own `__proto__` key.
 */
export function parseOpenCodeEnvelope(body: unknown): OpenCodeWireEnvelope | null {
	if (!isCleanObj(body)) return null;
	const info = body.opencode;
	if (!isCleanObj(info)) return null;
	const line = info.line;
	if ((line !== 1 && line !== 2) || info.protocol !== OPENCODE_WIRE_PROTOCOL) return null;

	const name = body.hook_event_name;
	if (typeof name !== "string") return null;
	const shapes: Record<string, DataShape> = line === 1 ? V1_SHAPES : V2_SHAPES;
	if (!Object.hasOwn(OPENCODE_EVENT_TO_HOOK_EVENT[line], name) || !Object.hasOwn(shapes, name)) {
		return null;
	}

	const sessionId = idOf(body.session_id);
	if (!sessionId) return null;
	if (!isCleanObj(body.data)) return null;
	const data = dataOf(shapes[name] as DataShape, body.data);
	if (!data) return null;

	const base: OpenCodeEnvelopeBase = { session_id: sessionId };
	if (body.parent_session_id !== undefined) {
		const parent = idOf(body.parent_session_id);
		if (!parent || parent === sessionId) return null;
		base.parent_session_id = parent;
	}
	if (body.cwd !== undefined) {
		const cwd = plainString(body.cwd, OPENCODE_CWD_MAX);
		if (!cwd) return null;
		base.cwd = cwd;
	}
	if (body.last_assistant_message !== undefined) {
		const last = textOf(body.last_assistant_message);
		if (last === null) return null;
		base.last_assistant_message = last;
	}
	const model = plainString(body.model, OPENCODE_MODEL_MAX);
	if (model) base.model = model;

	const wire: OpenCodeWireInfo = { line, protocol: OPENCODE_WIRE_PROTOCOL };
	const version = plainString(info.version, OPENCODE_VERSION_MAX);
	if (version) wire.version = version;

	return { ...base, opencode: wire, hook_event_name: name, data } as OpenCodeWireEnvelope;
}
