/**
 * D15 (F3): agent-supplied names are data inside LLM prompts, not
 * instructions. An agent's displayName can contain anything the agent
 * chooses to report — including `</sessions>`-shaped text or embedded
 * fake instruction lines — so it must never be spliced raw into a prompt.
 */
// xander F91: NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR
// (U+2029) are line breaks too, so they collapse like CR/LF.
const LINE_BREAKS_RE = /[\r\n\u0085\u2028\u2029]+/g;
// Remaining C0 controls + DEL, plus the zero-width and bidi ranges
// name-sanitizer.ts strips (U+200B-200F, U+202A-202E, U+2066-2069). Global
// patterns are only ever used with .replace() here, never .test() (F93).
const INVISIBLE_CHARS_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control characters from untrusted input
	/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function formatUntrustedInline(value: string): string {
	return value
		.replace(/</g, "‹")
		.replace(/>/g, "›")
		.replace(LINE_BREAKS_RE, " ")
		.replace(INVISIBLE_CHARS_RE, "");
}
