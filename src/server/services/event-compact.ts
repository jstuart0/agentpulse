/**
 * The compact form of an event: what a phone gets of one, on the socket and over REST.
 * The raw payload is replaced by a fixed, tiny subset (see `CompactRawPayload`), and no
 * field is over `fieldMaxBytes`. A field that was cut keeps its
 * type and holds a bounded preview, and the event gains a sibling flag
 * (`contentTruncated`, `toolInputTruncated`, `toolResponseTruncated`) so the client can
 * offer to fetch the full text from the uncompacted read.
 *
 * One definition for both surfaces, so an event looks the same however it reached the phone.
 */

/** Per-field budget on a compact event. */
export const COMPACT_FIELD_MAX_BYTES = 2048;

/** A single string value inside a toolInput preview is cut to this many bytes. */
const TOOL_INPUT_PREVIEW_VALUE_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Length(text: string): number {
	return encoder.encode(text).length;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = encoder.encode(text);
	if (bytes.length <= maxBytes) return text;
	return decoder.decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
}

/**
 * The top-level entries of a tool input that fit the budget, still an object:
 * string values are cut to TOOL_INPUT_PREVIEW_VALUE_BYTES, and a value that
 * still doesn't fit (a large nested object) is left out.
 */
function previewToolInput(
	input: Record<string, unknown>,
	fieldMaxBytes: number,
): Record<string, unknown> {
	const preview: Record<string, unknown> = {};
	let used = 2;
	for (const [key, raw] of Object.entries(input)) {
		const value = typeof raw === "string" ? truncateUtf8(raw, TOOL_INPUT_PREVIEW_VALUE_BYTES) : raw;
		const size = utf8Length(JSON.stringify(key)) + utf8Length(JSON.stringify(value) ?? "null") + 2;
		if (used + size > fieldMaxBytes) continue;
		preview[key] = value;
		used += size;
	}
	return preview;
}

/**
 * The only parts of a hook's raw payload a phone reads: how long a tool call took, how it ended, and which
 * call it was (so a Pre and a Post event pair up). Six fixed members, each a number, a boolean or a short id
 * (about 150 bytes at most), present only when the event carries them. Nothing else of the raw payload crosses, and `rawPayload` is left off the
 * event when none of these is found, so most events look exactly as they did.
 *
 *  - `duration_ms`: a finite number >= 0, from the hook's `duration_ms` (or `durationMs`), held to at most
 *    2^31 - 1 ms (about 24 days; a larger value is a bad clock, and the cap keeps it a safe 32-bit integer).
 *    A negative or non-numeric value is left out, not turned into 0.
 *  - `tool_use_id`: the hook's `tool_use_id`, a string of 1 to 64 characters. A longer one is left out, never cut,
 *    because a cut id would pair with the wrong call.
 *  - `exit_code`: a safe integer (`Number.isSafeInteger`), from a top-level `exit_code` / `exitCode`, else from a JSON tool
 *    response (`exit_code`, `exitCode`, `metadata.exit_code`).
 *  - `success`, `interrupted`, `is_error`: booleans, from the same top-level members or the same JSON
 *    tool response. Whether the call failed outright is `providerEventType` (`PostToolUseFailure`),
 *    which is already on the event.
 */
export interface CompactRawPayload {
	duration_ms?: number;
	tool_use_id?: string;
	exit_code?: number;
	success?: boolean;
	interrupted?: boolean;
	is_error?: boolean;
}

/** The longest `duration_ms` kept: the largest signed 32-bit integer. */
export const COMPACT_DURATION_MAX_MS = 2 ** 31 - 1;
/** The longest `tool_use_id` kept, in characters. */
export const COMPACT_TOOL_USE_ID_MAX_CHARS = 64;

const OUTCOME_BOOLEANS = ["success", "interrupted", "is_error"] as const;

/** A JSON tool response is read only when it can be a whole, small object: the raw copy is capped at 4096 characters. */
const TOOL_RESPONSE_PARSE_MAX_CHARS = 4096;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function integerOf(...candidates: unknown[]): number | undefined {
	return candidates.find((c): c is number => typeof c === "number" && Number.isSafeInteger(c));
}

function parsedToolResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
	const response = raw.tool_response;
	if (typeof response !== "string" || response.length > TOOL_RESPONSE_PARSE_MAX_CHARS) return null;
	if (!response.trimStart().startsWith("{")) return null;
	try {
		return asRecord(JSON.parse(response));
	} catch {
		return null;
	}
}

/** The allowlisted subset of a hook's raw payload, or undefined when it holds none of it. */
export function compactRawPayload(rawPayload: unknown): CompactRawPayload | undefined {
	const raw = asRecord(rawPayload);
	if (!raw) return undefined;
	const response = parsedToolResponse(raw);
	const meta = asRecord(response?.metadata);
	const out: CompactRawPayload = {};
	const duration = [raw.duration_ms, raw.durationMs].find(
		(c): c is number => typeof c === "number" && Number.isFinite(c) && c >= 0,
	);
	if (duration !== undefined) out.duration_ms = Math.min(duration, COMPACT_DURATION_MAX_MS);
	const toolUseId = raw.tool_use_id;
	if (
		typeof toolUseId === "string" &&
		toolUseId.length > 0 &&
		toolUseId.length <= COMPACT_TOOL_USE_ID_MAX_CHARS
	) {
		out.tool_use_id = toolUseId;
	}
	const exitCode = integerOf(
		raw.exit_code,
		raw.exitCode,
		response?.exit_code,
		response?.exitCode,
		meta?.exit_code,
	);
	if (exitCode !== undefined) out.exit_code = exitCode;
	for (const name of OUTCOME_BOOLEANS) {
		const value = [raw[name], response?.[name]].find((c): c is boolean => typeof c === "boolean");
		if (value !== undefined) out[name] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export type CompactEvent<T> = Omit<T, "rawPayload"> & {
	rawPayload?: CompactRawPayload;
	contentTruncated?: true;
	toolResponseTruncated?: true;
	toolInputTruncated?: true;
};

/** A copy of the event in its compact form; the input is not changed. */
export function compactEvent<T extends object>(
	event: T,
	fieldMaxBytes = COMPACT_FIELD_MAX_BYTES,
): CompactEvent<T> {
	const { rawPayload, ...compact } = event as T & { rawPayload?: unknown };
	const out = compact as Record<string, unknown>;
	const subset = compactRawPayload(rawPayload);
	if (subset) out.rawPayload = subset;
	for (const field of ["content", "toolResponse"] as const) {
		const value = out[field];
		if (typeof value === "string" && utf8Length(value) > fieldMaxBytes) {
			out[field] = truncateUtf8(value, fieldMaxBytes);
			out[`${field}Truncated`] = true;
		}
	}
	const toolInput = out.toolInput;
	if (
		toolInput &&
		typeof toolInput === "object" &&
		utf8Length(JSON.stringify(toolInput)) > fieldMaxBytes
	) {
		out.toolInput = previewToolInput(toolInput as Record<string, unknown>, fieldMaxBytes);
		out.toolInputTruncated = true;
	}
	return out as CompactEvent<T>;
}
