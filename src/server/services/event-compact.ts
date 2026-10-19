/**
 * The compact form of an event: what a phone gets of one, on the socket and over REST.
 * No raw payload, and no field over `fieldMaxBytes`. A field that was cut keeps its
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

export type CompactEvent<T> = Omit<T, "rawPayload"> & {
	contentTruncated?: true;
	toolResponseTruncated?: true;
	toolInputTruncated?: true;
};

/** A copy of the event in its compact form; the input is not changed. */
export function compactEvent<T extends object>(
	event: T,
	fieldMaxBytes = COMPACT_FIELD_MAX_BYTES,
): CompactEvent<T> {
	const { rawPayload: _dropped, ...compact } = event as T & { rawPayload?: unknown };
	const out = compact as Record<string, unknown>;
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
