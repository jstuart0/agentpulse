/** AGEN-69 phase 8b: when the clipboard refuses, the text is shown ready to select. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyBar, CopyFallback } from "./CopyFallback.js";

describe("CopyFallback", () => {
	test("a read-only text box holds the exact text, with the instruction in a status region and a Close button", () => {
		const html = renderToStaticMarkup(
			createElement(CopyFallback, { text: "line 1\n<b>2</b>", onClose: () => {} }),
		);
		expect(html).toMatch(/<textarea[^>]*readOnly[^>]*>line 1\n&lt;b&gt;2&lt;\/b&gt;<\/textarea>/);
		expect(html).toMatch(
			/<output[^>]*>Couldn&#x27;t copy automatically\. Select the text below and copy it\.<\/output>/,
		);
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>Close<\/button>/);
		expect(html).not.toContain("dangerouslySetInnerHTML");
	});
});

describe("CopyBar", () => {
	const render = (fallback: string | null) =>
		renderToStaticMarkup(
			createElement(CopyBar, {
				handoffLabel: "Copy handoff",
				summaryLabel: "Copy summary",
				onCopy: () => {},
				fallback,
				onCloseFallback: () => {},
			}),
		);

	test("two copy buttons and no text box while the last copy worked", () => {
		const html = render(null);
		expect(html.match(/data-copy/g)).toHaveLength(2);
		expect(html).not.toContain("<textarea");
	});

	test("after a refusal the text box appears with the text to copy by hand", () => {
		const html = render("the text");
		expect(html).toContain(">the text</textarea>");
		expect(html).toContain("Select the text below and copy it.");
	});
});
