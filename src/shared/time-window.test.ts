import { describe, expect, test } from "bun:test";
import { isWithinWindow } from "./time-window.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const PAST = 25 * 3_600_000;
const FUTURE = 5 * 60_000;

describe("isWithinWindow", () => {
	test("inclusive at both edges, outside one millisecond beyond", () => {
		expect(isWithinWindow(new Date(NOW - PAST).toISOString(), NOW, PAST, FUTURE)).toBe(true);
		expect(isWithinWindow(new Date(NOW - PAST - 1).toISOString(), NOW, PAST, FUTURE)).toBe(false);
		expect(isWithinWindow(new Date(NOW + FUTURE).toISOString(), NOW, PAST, FUTURE)).toBe(true);
		expect(isWithinWindow(new Date(NOW + FUTURE + 1).toISOString(), NOW, PAST, FUTURE)).toBe(false);
	});

	test("accepts the bare SQLite form as UTC", () => {
		expect(isWithinWindow("2026-11-01 11:59:00", NOW, PAST, FUTURE)).toBe(true);
	});

	test("anything unparseable or not a string is outside", () => {
		for (const bad of [123, {}, "", "NaN", "9999-99-99T00:00:00Z", null, undefined]) {
			expect(isWithinWindow(bad, NOW, PAST, FUTURE)).toBe(false);
		}
	});
});
