/**
 * Characters that change how text is laid out or vanish from it: bidirectional
 * controls and marks (which can make a name read as something else in a list) and
 * zero-width characters (which let two names look the same).
 */
const HIDDEN_FORMATTING = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * A name or label from a client, made safe to store and show: hidden formatting and
 * control characters removed, trimmed, and cut to `maxLength` characters. Anything
 * that isn't a string is the empty string.
 */
export function cleanDisplayText(input: unknown, maxLength: number): string {
	if (typeof input !== "string") return "";
	const printable = [...input.replace(HIDDEN_FORMATTING, "")].filter((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code > 0x1f && code !== 0x7f;
	});
	return printable.join("").trim().slice(0, maxLength);
}
