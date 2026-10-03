import { describe, expect, test } from "bun:test";
import { parseStoredTimestamp } from "./timestamp.js";

function withTZ<T>(tz: string, fn: () => T): T {
	const saved = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		process.env.TZ = saved ?? "UTC";
	}
}

const EPOCH_MS = Date.UTC(2026, 9, 1, 10, 0, 0); // 2026-10-01T10:00:00Z

describe("parseStoredTimestamp", () => {
	test("ISO with Z", () => {
		expect(parseStoredTimestamp("2026-10-01T10:00:00Z")).toBe(EPOCH_MS);
		expect(parseStoredTimestamp("2026-10-01T10:00:00.000Z")).toBe(EPOCH_MS);
	});

	test("SQLite bare format (zone-less, treated as UTC)", () => {
		expect(parseStoredTimestamp("2026-10-01 10:00:00")).toBe(EPOCH_MS);
		expect(parseStoredTimestamp("2026-10-01T10:00:00")).toBe(EPOCH_MS);
	});

	test("Postgres offset format", () => {
		expect(parseStoredTimestamp("2026-10-01 10:00:00+00")).toBe(EPOCH_MS);
		expect(parseStoredTimestamp("2026-10-01 05:00:00-05")).toBe(EPOCH_MS);
		expect(parseStoredTimestamp("2026-10-01 10:30:00+00:30")).toBe(EPOCH_MS);
		expect(parseStoredTimestamp("2026-10-01 10:00:00.123+00")).toBe(EPOCH_MS + 123);
	});

	test("null, undefined, empty, and garbage input are null", () => {
		expect(parseStoredTimestamp(null)).toBeNull();
		expect(parseStoredTimestamp(undefined)).toBeNull();
		expect(parseStoredTimestamp("")).toBeNull();
		expect(parseStoredTimestamp("not-a-date")).toBeNull();
		expect(parseStoredTimestamp("2026-13-99 99:99:99")).toBeNull();
	});

	test("result is identical under a non-UTC process TZ (zone-less values never read as local time)", () => {
		const cases = [
			"2026-10-01T10:00:00Z",
			"2026-10-01 10:00:00",
			"2026-10-01T10:00:00",
			"2026-10-01 05:00:00-05",
		];
		for (const value of cases) {
			const utc = parseStoredTimestamp(value);
			const inTokyo = withTZ("Asia/Tokyo", () => parseStoredTimestamp(value));
			const inLosAngeles = withTZ("America/Los_Angeles", () => parseStoredTimestamp(value));
			expect(inTokyo).toBe(utc);
			expect(inLosAngeles).toBe(utc);
		}
	});
});
