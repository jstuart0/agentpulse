// P8 patch-2 — M3: sanitizeSnippet U+0001 sentinel collision test.
import { describe, expect, test } from "bun:test";
import { sanitizeSnippet } from "./SearchPage.js";

// U+0001 byte used to construct test payloads without embedding literal control chars.
const SOH = "\u0001";

describe("M3 — sanitizeSnippet sentinel collision defense", () => {
	test("strips U+0001 bytes before sentinel swap — no <mark> injection", () => {
		// An attacker who stores "\u0001MARK_OPEN\u0001evil" in session content would
		// previously get a <mark> tag injected into the rendered snippet.
		const malicious = `${SOH}MARK_OPEN${SOH}evil`;
		const result = sanitizeSnippet(malicious);

		expect(result).not.toContain("<mark>");
		expect(result).not.toContain(SOH);
	});

	test("legitimate <mark> tags from FTS5 survive untouched", () => {
		const snippet = "found <mark>keyword</mark> here";
		const result = sanitizeSnippet(snippet);

		expect(result).toContain("<mark>keyword</mark>");
	});

	test("HTML in user content is escaped", () => {
		const snippet = "text <mark>hit</mark> and <script>alert(1)</script>";
		const result = sanitizeSnippet(snippet);

		expect(result).toContain("<mark>hit</mark>");
		expect(result).toContain("&lt;script&gt;");
		expect(result).not.toContain("<script>");
	});

	test("U+0001 bytes mixed with legit marks produce no injected marks", () => {
		// Tricky payload: stripped bytes shouldn't reconstitute a sentinel.
		const tricky = `${SOH}MARK_OPEN${SOH}${SOH}MARK_OPEN${SOH}injected<mark>legit</mark>text`;
		const result = sanitizeSnippet(tricky);

		// Only the legitimate FTS5 <mark> survives.
		expect(result.match(/<mark>/g)?.length ?? 0).toBe(1);
		expect(result).toContain("<mark>legit</mark>");
	});

	test("empty string returns empty string", () => {
		expect(sanitizeSnippet("")).toBe("");
	});

	test("string of only U+0001 bytes returns empty string", () => {
		expect(sanitizeSnippet(`${SOH}${SOH}${SOH}`)).toBe("");
	});
});
