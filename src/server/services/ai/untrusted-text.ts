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
//   U+00AD soft hyphen, U+034F combining grapheme joiner, U+061C arabic letter
//   mark, U+115F/U+1160/U+3164/U+FFA0 hangul fillers (blank-looking), U+180B-180F
//   mongolian variation selectors and vowel separator, U+200B-200F (zero-width,
//   direction marks), U+202A-202E and U+2066-2069 (bidi), U+2060-2065 and
//   U+206A-206F (word joiner, invisible operators, deprecated format controls),
//   U+FE00-FE0F (all variation selectors), U+FEFF (BOM), U+FFF9-FFFB
//   (interlinear annotation), U+1D173-1D17A (musical format controls), the
//   whole Unicode tag block U+E0000-E007F (a hidden ASCII message) and the
//   supplementary variation selectors U+E0100-E01EF (a second one: 240 values
//   can carry a byte each), and the C1 controls U+0080-009F. Global patterns
//   are only ever used with .replace() here, never .test() (F93).
const INVISIBLE_FORMAT_CLASS =
	"\\x80-\\x9F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2065\\u2066-\\u2069\\u206A-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";
// Remaining C0 controls + DEL, except LF and CR (collapsed to a space earlier
// by formatUntrustedInline).
const INVISIBLE_CHARS_RE = new RegExp(
	`[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F${INVISIBLE_FORMAT_CLASS}]`,
	"gu",
);
// The same, for text that keeps its lines: every C0 control and DEL goes except
// LF and TAB. NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR become LF first, so
// they cannot forge a line that a reader sees and a line-based check does not.
const INVISIBLE_KEEP_NEWLINES_RE = new RegExp(
	`[\\x00-\\x08\\x0B-\\x1F\\x7F${INVISIBLE_FORMAT_CLASS}]`,
	"gu",
);
const UNICODE_LINE_BREAKS_RE = /[\u0085\u2028\u2029]/g;

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

/** A fence tag is lowercase words joined by hyphens, starting with a letter. */
const FENCE_TAG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Wraps untrusted text in `<tag-NONCE>` ... `</tag-NONCE>`. The nonce is a
 * fresh random UUID per call, so nothing in the body can forge the closing
 * tag; as defence in depth every literal occurrence of the nonce (any case) is
 * scrubbed from the body first, repeatedly until none is left (a body that
 * nests a nonce inside a nonce cannot rebuild one from the pieces: the
 * replacement text contains no character a nonce is made of). The caller keeps
 * `nonce` to scrub it from the model's answer as well. `tag` is code's, not
 * data's, and must match /^[a-z][a-z0-9-]*$/.
 */
export function fenceUntrusted(tag: string, body: string): FencedText {
	if (!FENCE_TAG_RE.test(tag)) {
		throw new Error(`fenceUntrusted: tag must match ${FENCE_TAG_RE}, got ${JSON.stringify(tag)}`);
	}
	const nonce = crypto.randomUUID();
	const nonceRe = new RegExp(nonce, "gi");
	let safeBody = body;
	while (safeBody.toLowerCase().includes(nonce)) {
		safeBody = safeBody.replace(nonceRe, "[NONCE-REDACTED]");
	}
	return { text: `<${tag}-${nonce}>\n${safeBody}\n</${tag}-${nonce}>`, nonce };
}

/**
 * Strips the same invisible characters as formatUntrustedInline but keeps
 * `\n` (and tabs), for multi-line text such as a handoff. CR is stripped, so
 * CRLF becomes LF; NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR become `\n`.
 */
export function stripInvisibleKeepNewlines(value: string): string {
	return value.replace(UNICODE_LINE_BREAKS_RE, "\n").replace(INVISIBLE_KEEP_NEWLINES_RE, "");
}
