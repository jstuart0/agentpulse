/**
 * Moved from routes/sessions.ts:261-268 (Phase 2, D3/F20) so both the
 * CLAUDE.md sync checksum and the new /health `clients` drift-detection
 * checksums share one implementation. Behavior for existing callers is
 * unchanged — `trimEnd` is a new, default-off option for the relay/
 * statusline hashes, which must ignore trailing-newline-only diffs.
 * `length: "full"` returns the whole 64-hex digest (the release manifest's form); the default stays the
 * 16-hex prefix /health has always reported.
 */
export async function computeChecksum(
	content: string,
	options?: { trimEnd?: boolean; length?: "short" | "full" },
): Promise<string> {
	const input = options?.trimEnd ? content.trimEnd() : content;
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const hex = Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return options?.length === "full" ? hex : hex.slice(0, 16);
}
