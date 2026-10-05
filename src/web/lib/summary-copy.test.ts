/** AGEN-69 phase 8b: copying a summary to the clipboard, and what happens when the browser says no. */
import { describe, expect, test } from "bun:test";
import { STORED } from "../../shared/__fixtures__/session-summary-view/index.js";
import {
	buildContextMarkdown,
	buildHandoffMarkdown,
	buildSummaryMarkdown,
} from "./session-summary-view.js";
import {
	COPY_ANNOUNCEMENT,
	COPY_FALLBACK_LINE,
	buildCopyText,
	copyToClipboard,
} from "./summary-copy.js";

const META = { name: "demo", branch: "main", cwd: "/work/x" };

describe("copy text", () => {
	test("each kind uses its own builder", () => {
		expect(buildCopyText("handoff", STORED, META)).toBe(buildHandoffMarkdown(STORED, META));
		expect(buildCopyText("summary", STORED, META)).toBe(buildSummaryMarkdown(STORED, META));
		expect(buildCopyText("context", STORED, META)).toBe(buildContextMarkdown(STORED));
	});

	test("each kind has its own spoken confirmation", () => {
		expect(COPY_ANNOUNCEMENT).toEqual({
			handoff: "Handoff copied",
			summary: "Summary copied",
			context: "Context copied",
		});
	});
});

describe("copyToClipboard", () => {
	test("copied when the clipboard takes the text", async () => {
		const sent: string[] = [];
		expect(await copyToClipboard("hello", { writeText: async (t) => void sent.push(t) })).toBe(
			"copied",
		);
		expect(sent).toEqual(["hello"]);
	});

	test("refused when the API rejects, throws, or isn't there", async () => {
		expect(
			await copyToClipboard("x", {
				writeText: async () => {
					throw new Error("denied");
				},
			}),
		).toBe("refused");
		expect(await copyToClipboard("x", null)).toBe("refused");
		expect(await copyToClipboard("x", {} as never)).toBe("refused");
	});

	test("the fallback line tells the person what to do", () => {
		expect(COPY_FALLBACK_LINE).toBe(
			"Couldn't copy automatically. Select the text below and copy it.",
		);
	});
});
