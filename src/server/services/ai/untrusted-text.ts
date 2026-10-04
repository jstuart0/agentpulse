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

export interface FencedText {
	/** The body wrapped in one open and one close tag carrying the nonce. */
	text: string;
	nonce: string;
}

/**
 * Wraps untrusted text in `<tag-NONCE>` ... `</tag-NONCE>`. The nonce is a
 * fresh random UUID per call, so nothing in the body can forge the closing
 * tag; as defence in depth every literal occurrence of the nonce (any case) is
 * scrubbed from the body first. The caller keeps `nonce` to scrub it from the
 * model's answer as well.
 */
export function fenceUntrusted(tag: string, body: string): FencedText {
	const nonce = crypto.randomUUID();
	const safeBody = body.replace(new RegExp(nonce, "gi"), "[NONCE-REDACTED]");
	return { text: `<${tag}-${nonce}>\n${safeBody}\n</${tag}-${nonce}>`, nonce };
}

/** Like formatUntrustedInline but keeps `\n`. (Phase 2b stub.) */
export function stripInvisibleKeepNewlines(value: string): string {
	return value;
}
