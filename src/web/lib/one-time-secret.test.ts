import { describe, expect, test } from "bun:test";
import { SECRET_LIFETIME_MS, shouldClearSecret } from "./one-time-secret.js";

describe("shouldClearSecret", () => {
	test("five minutes", () => {
		expect(SECRET_LIFETIME_MS).toBe(300_000);
	});

	test("kept while the tab is visible and the time isn't up", () => {
		expect(shouldClearSecret({ shownAt: 1000, now: 1000 + 299_999, tabHidden: false })).toBe(false);
	});

	test("cleared when the time is up", () => {
		expect(shouldClearSecret({ shownAt: 1000, now: 1000 + 300_000, tabHidden: false })).toBe(true);
	});

	test("cleared as soon as the tab is hidden", () => {
		expect(shouldClearSecret({ shownAt: 1000, now: 1001, tabHidden: true })).toBe(true);
	});
});
