import { createHash } from "node:crypto";

/**
 * The text the agent is sent for a proposed prompt: the proposal's `nextPrompt`, trimmed. The push's
 * `promptHash`, the inbox item, the decision, the delivery record and a retry all use this one
 * normalization, so they cannot disagree about what was reviewed. No Unicode normalization is applied:
 * the hash is of the exact UTF-8 bytes, so NFC and NFD spellings of the same word hash differently.
 */
export function proposedPromptText(nextPrompt: string | null | undefined): string {
	return (nextPrompt ?? "").trim();
}

/** SHA-256 of a prompt, lowercase hex: the value a phone sends back as `promptHash`. */
export function hashPrompt(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** The hash a client must send to approve this proposal, or null when there is nothing to approve. */
export function promptHashOf(nextPrompt: string | null | undefined): string | null {
	const text = proposedPromptText(nextPrompt);
	return text ? hashPrompt(text) : null;
}
