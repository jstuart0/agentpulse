/**
 * D15 (F3): agent-supplied names are data inside LLM prompts, not
 * instructions. An agent's displayName can contain anything the agent
 * chooses to report — including `</sessions>`-shaped text or embedded
 * fake instruction lines — so it must never be spliced raw into a prompt.
 */
// xander F91: NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR
// (U+2029) are line breaks too, so they collapse like CR/LF.
const LINE_BREAKS_RE = /[\r\n\u0085\u2028\u2029]+/g;
// Zero-width, bidi and invisible format characters. Shared by both helpers:
// U+00AD soft hyphen, U+034F combining grapheme joiner, U+180E, U+200B-200F
// (zero-width, direction marks), U+202A-202E and U+2066-2069 (bidi), U+2060-2064
// (word joiner and invisible operators), U+FE0F (variation selector-16), U+FEFF
// (BOM) and the whole Unicode tag block U+E0000-E007F, which can carry a hidden
// ASCII message. Global patterns are only ever used with .replace() here,
// never .test() (F93).
const INVISIBLE_FORMAT_CLASS =
	"\\u00AD\\u034F\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFE0F\\uFEFF\\u{E0000}-\\u{E007F}";
// Remaining C0 controls + DEL, except LF and CR (collapsed to a space earlier
// by formatUntrustedInline).
const INVISIBLE_CHARS_RE = new RegExp(
	`[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F${INVISIBLE_FORMAT_CLASS}]`,
	"gu",
);
// The same, for text that keeps its lines: every C0 control and DEL goes except
// LF and TAB.
const INVISIBLE_KEEP_NEWLINES_RE = new RegExp(
	`[\\x00-\\x08\\x0B-\\x1F\\x7F${INVISIBLE_FORMAT_CLASS}]`,
	"gu",
);

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

/**
 * Strips the same invisible characters as formatUntrustedInline but keeps
 * `\n` (and tabs), for multi-line text such as a handoff. CR is stripped, so
 * CRLF becomes LF.
 */
export function stripInvisibleKeepNewlines(value: string): string {
	return value.replace(INVISIBLE_KEEP_NEWLINES_RE, "");
}
