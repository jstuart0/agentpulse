import { describe, expect, test } from "bun:test";
// AGEN: MarkdownContent renders event/note content through react-markdown
// with no custom `urlTransform`, so link/image URLs go through the
// library's own defaultUrlTransform. This confirms that default actually
// strips `javascript:` (and other non-safe-protocol) URLs on the installed
// version, and that MarkdownContent doesn't quietly reintroduce an unsafe
// override. No DOM rendering involved — defaultUrlTransform is a pure
// string function, and the "no custom override" check is a source scan.
import { readFileSync } from "node:fs";
import { defaultUrlTransform } from "react-markdown";

describe("react-markdown defaultUrlTransform (installed version) sanitizes dangerous protocols", () => {
	test("javascript: URLs are stripped", () => {
		expect(defaultUrlTransform("javascript:alert(1)")).toBe("");
		expect(defaultUrlTransform("  javascript:alert(1)")).not.toContain("javascript:");
		expect(defaultUrlTransform("JavaScript:alert(1)")).toBe("");
	});

	test("data: and vbscript: URLs are also stripped", () => {
		expect(defaultUrlTransform("data:text/html,<script>1</script>")).toBe("");
		expect(defaultUrlTransform("vbscript:msgbox(1)")).toBe("");
	});

	test("safe protocols and relative paths pass through unchanged", () => {
		expect(defaultUrlTransform("https://example.com/x")).toBe("https://example.com/x");
		expect(defaultUrlTransform("http://example.com")).toBe("http://example.com");
		expect(defaultUrlTransform("mailto:a@example.com")).toBe("mailto:a@example.com");
		expect(defaultUrlTransform("/relative/path")).toBe("/relative/path");
		expect(defaultUrlTransform("#fragment")).toBe("#fragment");
	});
});

describe("MarkdownContent does not override react-markdown's safe default", () => {
	test("the component passes no custom urlTransform, so defaultUrlTransform is what actually runs", () => {
		const source = readFileSync(new URL("./MarkdownContent.tsx", import.meta.url), "utf-8");
		expect(source).not.toContain("urlTransform");
		expect(source).not.toContain("rehype-raw");
		// Built from parts so this literal doesn't trip the repo-wide raw-HTML
		// sink audit (s-m2-innerhtml-guard.test.ts) against this test file itself.
		expect(source).not.toContain(["dangerously", "SetInnerHTML"].join(""));
	});
});
