/**
 * The last check before text is typed into a coding agent.
 *
 * Every send passes it, whoever asked: a person approving in the dashboard, a
 * person tapping in Telegram, or the auto policy. It exists because what the
 * agent's terminal receives is not the same as what a human sees: invisible
 * characters, a line break that submits a second command, an escape sequence,
 * or a leading slash, bang or at-sign that the agent treats as a command
 * rather than as a request.
 *
 *  1. Bidi and invisible format characters are stripped (they are never wanted
 *     in a prompt and can reorder or hide what a reviewer reads).
 *  2. Unicode whitespace is trimmed from both ends (an NBSP in front of a bang
 *     would otherwise hide it from an ASCII-only trim).
 *  3. What is left is refused when it has: any C0/C1 control character, ESC or
 *     DEL; a line break of any kind (CR, LF, NEL, U+2028, U+2029); a first
 *     character that is not a letter or a digit (an allowlist, so every
 *     leading sigil is out, now and in future agent versions); or a force
 *     push (`--force`, `-f` on `git push`, `+refs` and `+<ref>:` refspecs,
 *     `HEAD:main` / `HEAD:master`).
 *
 * It is a backstop for human-approved text. The auto policy never sends model
 * text at all, only fixed templates, which pass it unchanged.
 */

/** Longest text the sanitiser looks at: bounds every regex below. */
export const SANITISER_MAX_CHARS = 4_000;

export type SanitiseRefusal =
	| "empty"
	| "too_long"
	| "control_character"
	| "line_break"
	| "bad_first_character"
	| "force_push"
	| "refspec_push";

export type SanitiseResult = { ok: true; text: string } | { ok: false; reason: SanitiseRefusal };

type CodePointRange = readonly [first: number, last: number];

/**
 * Zero-width, bidi and invisible format characters (the inventory in
 * untrusted-text.ts, without the C1 controls). C0/C1 controls are deliberately
 * NOT here: they are refused, not silently dropped, so a pasted escape
 * sequence fails loudly.
 */
const INVISIBLE_RANGES: readonly CodePointRange[] = [
	[0x00ad, 0x00ad],
	[0x034f, 0x034f],
	[0x061c, 0x061c],
	[0x115f, 0x1160],
	[0x180b, 0x180f],
	[0x200b, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x206f],
	[0x3164, 0x3164],
	[0xfe00, 0xfe0f],
	[0xfeff, 0xfeff],
	[0xffa0, 0xffa0],
	[0xfff9, 0xfffb],
	[0x1d173, 0x1d17a],
	[0xe0000, 0xe007f],
	[0xe0100, 0xe01ef],
];

const LINE_BREAK_POINTS: readonly CodePointRange[] = [
	[0x0a, 0x0a],
	[0x0d, 0x0d],
	[0x85, 0x85],
	[0x2028, 0x2029],
];

const BACKSLASH = String.fromCharCode(92);

/** A regex character class for the ranges, written with code-point escapes. */
function classOf(ranges: readonly CodePointRange[]): string {
	const point = (cp: number) => `${BACKSLASH}u{${cp.toString(16)}}`;
	return `[${ranges.map(([a, b]) => (a === b ? point(a) : `${point(a)}-${point(b)}`)).join("")}]`;
}

const INVISIBLE_RE = new RegExp(classOf(INVISIBLE_RANGES), "gu");
const LINE_BREAK_RE = new RegExp(classOf(LINE_BREAK_POINTS), "u");
const EDGE_WHITESPACE_RE = /^[\p{White_Space}]+|[\p{White_Space}]+$/gu;
const CONTROL_RE = new RegExp(
	classOf([
		[0x00, 0x1f],
		[0x7f, 0x9f],
	]),
	"u",
);
// Everything but a line break that should show up as damage in a readable copy.
const READABLE_COPY_CONTROL_RE = new RegExp(
	classOf([
		[0x00, 0x09],
		[0x0b, 0x1f],
		[0x7f, 0x9f],
	]),
	"gu",
);
const FIRST_CHARACTER_RE = /^[\p{L}\p{N}]/u;

// Force pushes. Bounded: the input is already capped.
const LONG_FORCE_RE = /--force/i;
const SHORT_FORCE_RE = /\bgit\s+push\b[^\n]*\s-[A-Za-z]*f[A-Za-z]*(?=\s|$)/i;
const PLUS_REFSPEC_RE = /(?:^|\s)\+[A-Za-z0-9_./-]+:/;
const PLUS_REFS_RE = /(?:^|\s)\+refs\//i;
const HEAD_TO_MAIN_RE = /\bHEAD:(?:main|master)\b/i;

export function sanitizeOutboundPrompt(input: string): SanitiseResult {
	if (typeof input !== "string") return { ok: false, reason: "empty" };
	if (input.length > SANITISER_MAX_CHARS) return { ok: false, reason: "too_long" };

	const text = input.replace(INVISIBLE_RE, "").replace(EDGE_WHITESPACE_RE, "");
	if (text === "") return { ok: false, reason: "empty" };
	if (LINE_BREAK_RE.test(text)) return { ok: false, reason: "line_break" };
	if (CONTROL_RE.test(text)) return { ok: false, reason: "control_character" };
	if (!FIRST_CHARACTER_RE.test(text)) return { ok: false, reason: "bad_first_character" };
	if (LONG_FORCE_RE.test(text) || SHORT_FORCE_RE.test(text)) {
		return { ok: false, reason: "force_push" };
	}
	if (PLUS_REFSPEC_RE.test(text) || PLUS_REFS_RE.test(text) || HEAD_TO_MAIN_RE.test(text)) {
		return { ok: false, reason: "refspec_push" };
	}
	return { ok: true, text };
}

/**
 * A copy a person can read and edit when the original can't be sent: invisible
 * characters removed, control characters other than a line break replaced by
 * the replacement character so they are visible as damage rather than acted on.
 */
export function readableCopyOf(input: string): string {
	return input
		.replace(INVISIBLE_RE, "")
		.replace(READABLE_COPY_CONTROL_RE, String.fromCharCode(0xfffd));
}
