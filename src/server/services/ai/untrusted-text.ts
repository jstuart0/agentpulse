/**
 * D15 (F3): agent-supplied names are data inside LLM prompts, not
 * instructions. An agent's displayName can contain anything the agent
 * chooses to report — including `</sessions>`-shaped text or embedded
 * fake instruction lines — so it must never be spliced raw into a prompt.
 */
export function formatUntrustedInline(value: string): string {
	return (
		value
			.replace(/</g, "‹")
			.replace(/>/g, "›")
			.replace(/[\r\n]+/g, " ")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control characters from untrusted input
			.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
	);
}
