/**
 * Moved from routes/sessions.ts:261-268 (Phase 2, D3/F20) so both the
 * CLAUDE.md sync checksum and the new /health `clients` drift-detection
 * checksums share one implementation. Behavior for existing callers is
 * unchanged — `trimEnd` is a new, default-off option for the relay/
 * statusline hashes, which must ignore trailing-newline-only diffs.
 */
export async function computeChecksum(
	content: string,
	options?: { trimEnd?: boolean },
): Promise<string> {
	const input = options?.trimEnd ? content.trimEnd() : content;
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}
