import { describe, expect, test } from "bun:test";
import { formatTaskPrompt } from "./ask-launch-handler.js";

describe("formatTaskPrompt", () => {
	test("renders all constraint lines with full taskBrief", () => {
		const out = formatTaskPrompt(
			{
				summary: "Write a plan about caching strategies",
				outputPath: "thoughts/",
				format: "markdown",
			},
			undefined,
		);
		expect(out).toContain("Read CLAUDE.md if present in this directory before starting.");
		expect(out).toContain("Task: Write a plan about caching strategies");
		expect(out).toContain("Place the deliverable under `thoughts/` if relevant.");
		expect(out).toContain("Use markdown format.");
		expect(out).toContain("Follow project conventions");
		expect(out).toContain("Report when done.");
	});

	test("omits optional constraint lines when only summary is set", () => {
		const out = formatTaskPrompt({ summary: "Investigate the failing tests" }, undefined);
		expect(out).toContain("Read CLAUDE.md if present in this directory before starting.");
		expect(out).toContain("Task: Investigate the failing tests");
		expect(out).not.toContain("Place the deliverable");
		expect(out).not.toContain("Use ");
		expect(out).toContain("Follow project conventions");
		expect(out).toContain("Report when done.");
	});

	test("falls back to taskHint with the Read CLAUDE.md prefix when taskBrief is absent", () => {
		const out = formatTaskPrompt(undefined, "look at the failing tests");
		expect(out).toBe(
			"Read CLAUDE.md if present in this directory before starting.\n\nlook at the failing tests",
		);
	});

	test("returns empty string when neither taskBrief nor taskHint is provided", () => {
		expect(formatTaskPrompt(undefined, undefined)).toBe("");
		expect(formatTaskPrompt(undefined, "")).toBe("");
	});
});
