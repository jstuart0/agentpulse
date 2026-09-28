/**
 * Shared sanitizer for agent-reported session/thread names (D14, F79).
 *
 * Extracted out of session-tracker.ts so it's independently importable:
 * `__fixtures__/native-name-sanitizer.json` is the {input, expected} contract
 * both this server's test (name-sanitizer.test.ts) and Phase 3's
 * self-contained relay (which can't import server code, so it duplicates
 * this function — see plan D23) are checked against.
 *
 * F11/xander L2: strips C0 controls + DEL, and the bidi/zero-width ranges
 * that can spoof a name's visual reading order or hide characters
 * (U+200B-200F zero-width, U+202A-202E bidi override, U+2066-2069 bidi
 * isolate). Applied before trimming/capping so a name that's ONLY these
 * characters correctly sanitizes to empty, not to whitespace.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control characters from untrusted input
export const UNSAFE_NAME_CHARS_RE = /[\x00-\x1F\x7F​-‏‪-‮⁦-⁩]/g;
export const MAX_NATIVE_NAME_CODE_POINTS = 200;

// percy F82 (measured): the regex strip + `[...string]` spread below are
// O(length) — a 20 MB `name` field (no body-size limit gates PUT
// /native-name upstream) costs ~118ms per call. Bound the raw input to a
// generous multiple of the final 200-code-point cap *before* any of that
// work runs. 4096 UTF-16 code units is far more than any legitimate native
// name needs and still leaves the code-point-safe truncation below plenty
// of room; a request that pads with junk beyond this point is sanitizing
// "the first N characters", not the full payload — that's the intended
// trade-off, not a bug.
export const PRE_CAP_CODE_UNITS = 4096;

function preCapCodeUnits(raw: string): string {
	if (raw.length <= PRE_CAP_CODE_UNITS) return raw;
	let end = PRE_CAP_CODE_UNITS;
	const lastUnit = raw.charCodeAt(end - 1);
	// Never let the cheap pre-cap itself split a surrogate pair — back off
	// one code unit if it would land on a lone leading (high) surrogate.
	if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
	return raw.slice(0, end);
}

export function sanitizeNativeName(raw: string): string {
	const bounded = preCapCodeUnits(raw);
	const stripped = bounded.replace(UNSAFE_NAME_CHARS_RE, "").trim();
	const codePoints = [...stripped];
	// Code-point-safe truncation — a naive string.slice(0, N) can split a
	// surrogate pair, leaving a lone surrogate (renders as U+FFFD / mojibake).
	return codePoints.length > MAX_NATIVE_NAME_CODE_POINTS
		? codePoints.slice(0, MAX_NATIVE_NAME_CODE_POINTS).join("")
		: stripped;
}
