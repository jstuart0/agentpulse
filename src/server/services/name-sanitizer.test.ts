import { describe, expect, test } from "bun:test";
import fixtures from "./__fixtures__/native-name-sanitizer.json";
import { PRE_CAP_CODE_UNITS, sanitizeNativeName } from "./name-sanitizer.js";

/**
 * F79 (librarian mid-build): the fixture is the contract — this server test
 * consumes it now, and Phase 3's self-contained relay (which duplicates
 * sanitizeNativeName rather than importing server code) is checked against
 * the same fixture in its own parity test.
 */
describe("sanitizeNativeName — shared fixture (F79)", () => {
	for (const c of fixtures as Array<{ name: string; input: string; expected: string }>) {
		test(c.name, () => {
			expect(sanitizeNativeName(c.input)).toBe(c.expected);
		});
	}
});

describe("sanitizeNativeName — pre-cap performance guard (F82, percy)", () => {
	test("a 20 MB name sanitizes in well under 5ms and matches sanitizing the first PRE_CAP_CODE_UNITS characters", () => {
		const huge = "x".repeat(20 * 1024 * 1024);
		const start = performance.now();
		const result = sanitizeNativeName(huge);
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(5);
		expect(result).toBe(sanitizeNativeName(huge.slice(0, PRE_CAP_CODE_UNITS)));
	});

	test("the pre-cap never splits a surrogate pair straddling its own boundary", () => {
		// Place an astral character exactly on the PRE_CAP_CODE_UNITS boundary.
		const huge = `${"x".repeat(PRE_CAP_CODE_UNITS - 1)}\u{1F600}${"y".repeat(1000)}`;
		const result = sanitizeNativeName(huge);
		expect(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(result),
		).toBe(false);
	});
});
