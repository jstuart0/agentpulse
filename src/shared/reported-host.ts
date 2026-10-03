/**
 * The machine name a hook says it came from.
 *
 * Display only. The value is self-declared by whatever sent the request, so it
 * is unauthenticated: it must never feed an ownership, access, routing or any
 * other decision, and it is only ever shown as text. A managed (supervisor
 * launched) session's host comes from the supervisor's registration instead and
 * outranks this in the UI.
 *
 * It travels in the X-AgentPulse-Host header (HOST_HEADER), never inside the
 * hook body. The sender percent-encodes it so that any machine name, including
 * one with characters outside Latin-1, is a valid header value and can never
 * make a request fail; the server decodes and cleans it.
 */

export const REPORTED_HOST_MAX_LENGTH = 128;

/** Longest header value looked at: a 128-character name can encode to 12 characters per character. */
const REPORTED_HOST_HEADER_MAX_LENGTH = 2048;

/** Control, format (zero-width, bidi), line and paragraph separator, and lone surrogate characters. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/** Any run of whitespace, including NBSP and other space separators. */
const WHITESPACE_RUN = /[\s\p{Zs}]+/gu;

/** Trim, strip unsafe characters, collapse interior whitespace to one space, cap at 128 characters; null when nothing is left. */
export function sanitizeReportedHost(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.replace(UNSAFE_CHARACTERS, "").replace(WHITESPACE_RUN, " ").trim();
	const capped = Array.from(cleaned).slice(0, REPORTED_HOST_MAX_LENGTH).join("").trim();
	return capped.length > 0 ? capped : null;
}

/** The server's reading of the header: decoded, then cleaned; null when absent, malformed or empty. */
export function parseReportedHostHeader(value: string | null | undefined): string | null {
	if (!value || value.length > REPORTED_HOST_HEADER_MAX_LENGTH) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return null;
	}
	return sanitizeReportedHost(decoded);
}

/** What a sender puts in the header; "" when there is no usable name (send no header then). */
export function encodeReportedHostHeader(name: string): string {
	const cleaned = sanitizeReportedHost(name);
	return cleaned === null ? "" : encodeURIComponent(cleaned);
}
