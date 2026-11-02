import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MANAGED_REPORT_BODY_LIMIT_BYTES,
	MAX_EVENT_CONTENT_CHARS,
	clampEventContent,
} from "./managed-report-limits.js";

describe("clampEventContent", () => {
	test("short, absent and exactly-at-the-limit content is untouched", () => {
		expect(clampEventContent("hello")).toBe("hello");
		expect(clampEventContent(undefined)).toBeUndefined();
		expect(clampEventContent(null)).toBeNull();
		const exact = "x".repeat(MAX_EVENT_CONTENT_CHARS);
		expect(clampEventContent(exact)).toBe(exact);
	});

	test("longer content is cut to the limit", () => {
		expect(clampEventContent("x".repeat(MAX_EVENT_CONTENT_CHARS + 50))).toHaveLength(
			MAX_EVENT_CONTENT_CHARS,
		);
	});

	test("a cut never leaves half a surrogate pair", () => {
		const text = `${"x".repeat(MAX_EVENT_CONTENT_CHARS - 1)}\u{1F600}tail`;
		const cut = clampEventContent(text);
		expect(cut).toHaveLength(MAX_EVENT_CONTENT_CHARS - 1);
	});
});

describe("the server uses the same limits", () => {
	test("the managed routes read their body and content limits from this module", () => {
		const route = readFileSync(join(import.meta.dir, "../server/routes/supervisors.ts"), "utf-8");
		expect(route).toContain("managed-report-limits.js");
		expect(route).not.toMatch(/const MAX_EVENT_CONTENT_CHARS\s*=/);
		expect(route).not.toMatch(/const MANAGED_REPORT_BODY_LIMIT_BYTES\s*=/);
		expect(MANAGED_REPORT_BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
	});
});
