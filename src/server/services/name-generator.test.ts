import { describe, expect, test } from "bun:test";

import { generateSessionName, randomSlugSuffix, slugifyTaskName } from "./name-generator.js";

describe("slugifyTaskName", () => {
	test("kebabs and clamps a long sentence to 4 words", () => {
		expect(slugifyTaskName("Create a plan about caching strategies")).toBe("create-a-plan-about");
	});

	test("strips punctuation and collapses to clean words", () => {
		expect(slugifyTaskName("Plan: caching")).toBe("plan-caching");
	});

	test("returns empty string on empty input", () => {
		expect(slugifyTaskName("")).toBe("");
	});

	test("returns empty string when only symbols are present", () => {
		expect(slugifyTaskName("!!!@@@###")).toBe("");
	});

	test("caps total length at 40 characters", () => {
		const slug = slugifyTaskName("a".repeat(100));
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.length).toBeGreaterThan(0);
	});

	test("collapses runs of whitespace and joins with hyphen", () => {
		expect(slugifyTaskName("Multi   word    spacing")).toBe("multi-word-spacing");
	});

	test("lowercases mixed-case input", () => {
		expect(slugifyTaskName("UPPER CASE Words")).toBe("upper-case-words");
	});

	test("ignores non-string input safely", () => {
		// biome-ignore lint/suspicious/noExplicitAny: defensively probing the input contract
		expect(slugifyTaskName(undefined as any)).toBe("");
		// biome-ignore lint/suspicious/noExplicitAny: defensively probing the input contract
		expect(slugifyTaskName(null as any)).toBe("");
	});

	test("handles unicode by stripping it (ascii-only output)", () => {
		expect(slugifyTaskName("café résumé")).toBe("caf-r-sum");
	});
});

describe("randomSlugSuffix", () => {
	test("returns a 4-char base36 string", () => {
		for (let i = 0; i < 16; i++) {
			const suffix = randomSlugSuffix();
			expect(suffix).toMatch(/^[a-z0-9]{4}$/);
		}
	});
});

describe("generateSessionName", () => {
	test("matches the auto-generated adjective-noun shape", () => {
		for (let i = 0; i < 16; i++) {
			expect(generateSessionName()).toMatch(/^[a-z]+-[a-z]+$/);
		}
	});
});
