import { describe, expect, test } from "bun:test";
import { HOST_TEXT_MAX_CHARS, cleanHostText } from "./clean-host-text.js";

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

describe("cleanHostText", () => {
	test("only a string is text", () => {
		for (const value of [undefined, null, 5, {}, ["a"]]) expect(cleanHostText(value)).toBeNull();
	});

	test("controls become spaces and format characters (bidi, zero-width) vanish", () => {
		expect(cleanHostText(`a${NUL}b${ESC}[31mc\r\nd`)).toBe("a b [31mc d");
		expect(cleanHostText(`pay${RLO}exe.txt${ZWSP}${LRI}x${PDI}`)).toBe("payexe.txtx");
	});

	test("nothing left is null", () => {
		expect(cleanHostText(`  ${RLO}${ZWSP} \n`)).toBeNull();
	});

	test("long text is cut at the cap on a character boundary, with an ellipsis", () => {
		const out = cleanHostText("x".repeat(HOST_TEXT_MAX_CHARS + 50)) ?? "";
		expect(Array.from(out)).toHaveLength(HOST_TEXT_MAX_CHARS + 1);
		expect(out.endsWith("…")).toBe(true);
		const emoji = cleanHostText("😀".repeat(HOST_TEXT_MAX_CHARS + 1)) ?? "";
		expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(cleanHostText("short")).toBe("short");
	});
});
