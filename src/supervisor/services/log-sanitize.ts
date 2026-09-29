/**
 * F49 (2026-09-29-deliver-supervisor-auth-routing, xander spot check):
 * the supervisor logs the server's own response status text and JSON
 * error body field on every registration/report failure (F43). Both are
 * attacker-controlled if the server (or a network-position attacker
 * sitting on an unencrypted http:// path, F37) is malicious or
 * compromised — an oversized body, a forged newline-delimited fake log
 * line, or a terminal ANSI escape sequence could otherwise land verbatim
 * in the supervisor's local log file. This module bounds and sanitizes
 * both before anything is logged.
 */

export const MAX_LOG_STRING_LENGTH = 200;
export const MAX_ERROR_BODY_BYTES = 8 * 1024;

/**
 * Strip ANSI/VT100 CSI escape sequences (ESC [ ... letter), then any
 * remaining raw control character (including a bare ESC with no complete
 * sequence, newlines, carriage returns, tabs), then cap the length. Safe
 * to call on any untrusted string before it's logged.
 */
export function sanitizeForLog(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping ANSI escapes from untrusted server input
	const withoutAnsi = value.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars (incl. newlines) from untrusted server input
	const withoutControl = withoutAnsi.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return withoutControl.slice(0, MAX_LOG_STRING_LENGTH);
}

/**
 * Read at most `maxBytes` of `res`'s body as text. Unlike `res.text()`,
 * this never buffers more than the cap into memory — the underlying
 * stream is cancelled the moment the cap is reached, so an oversized or
 * slow-drip response body can't be used to exhaust supervisor memory.
 */
export async function readBoundedText(
	res: Response,
	maxBytes: number = MAX_ERROR_BODY_BYTES,
): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	try {
		while (received < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			const remaining = maxBytes - received;
			const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			text += decoder.decode(slice, { stream: true });
			received += slice.byteLength;
			if (slice.byteLength < value.byteLength) break; // hit the cap mid-chunk
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// stream already closed — fine
		}
	}
	text += decoder.decode();
	return text;
}

/**
 * Best-effort: read a bounded slice of `res`'s body, JSON.parse it, and
 * return its `error` field sanitized for logging — or undefined for a
 * non-JSON body, a missing/non-string `error` field, an empty body, or a
 * body so large the truncated slice no longer parses as valid JSON.
 * Never throws.
 */
export async function parseErrorBodyField(
	res: Response,
	maxBytes: number = MAX_ERROR_BODY_BYTES,
): Promise<string | undefined> {
	try {
		const text = await readBoundedText(res, maxBytes);
		if (!text) return undefined;
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const raw = (parsed as { error?: unknown }).error;
			if (typeof raw === "string") return sanitizeForLog(raw);
		}
		return undefined;
	} catch {
		return undefined;
	}
}
