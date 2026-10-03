import { describe, expect, test } from "bun:test";
import { parseDbTimestamp, toDbTimestamp } from "./db-time.js";

const FILE_TZ = process.env.TZ;

function withTZ<T>(tz: string, fn: () => T): T {
	const saved = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		process.env.TZ = saved ?? "UTC";
	}
}

const ZONES = ["America/New_York", "Asia/Kolkata"];
const INSTANT = Date.UTC(2026, 8, 28, 12, 0, 5);

describe("parseDbTimestamp (DT-1)", () => {
	for (const tz of ZONES) {
		test(`bare SQLite value is UTC under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28 12:00:05")).toBe(INSTANT);
			});
		});

		test(`bare value with fractional seconds under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28 12:00:05.25")).toBe(INSTANT + 250);
				expect(parseDbTimestamp("2026-09-28 12:00:05.123456")).toBe(INSTANT + 123);
			});
		});

		test(`ISO Z value under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28T12:00:05.000Z")).toBe(INSTANT);
				expect(parseDbTimestamp("2026-09-28T12:00:05Z")).toBe(INSTANT);
			});
		});

		test(`Postgres offset forms under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28 12:00:05+00")).toBe(INSTANT);
				expect(parseDbTimestamp("2026-09-28 08:00:05-04")).toBe(INSTANT);
				expect(parseDbTimestamp("2026-09-28 17:30:05.5+05:30")).toBe(INSTANT + 500);
				expect(parseDbTimestamp("2026-09-28 12:00:05.123456+00")).toBe(INSTANT + 123);
			});
		});

		test(`empty, null and garbage are null under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("")).toBeNull();
				expect(parseDbTimestamp(null)).toBeNull();
				expect(parseDbTimestamp(undefined)).toBeNull();
				expect(parseDbTimestamp("garbage")).toBeNull();
				expect(parseDbTimestamp("2026-13-45 99:00:00")).toBeNull();
			});
		});

		// F85: a date with no time component must not silently parse as
		// midnight — the regex requires the time portion.
		test(`a date-only value is null under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28")).toBeNull();
			});
		});

		// F85: 4-digit fractional seconds truncate to 3 (milliseconds), not
		// round — ".9999" is +999ms, never +1000ms (which would silently roll
		// into the next second).
		test(`four-digit fractional seconds truncate to +999ms under ${tz}`, () => {
			withTZ(tz, () => {
				expect(parseDbTimestamp("2026-09-28 12:00:05.9999")).toBe(INSTANT + 999);
			});
		});
	}
});

describe("toDbTimestamp (DT-1)", () => {
	for (const tz of ZONES) {
		test(`formats UTC, truncated to the second, under ${tz}`, () => {
			withTZ(tz, () => {
				expect(toDbTimestamp(new Date(Date.UTC(2026, 8, 28, 12, 0, 5, 999)))).toBe(
					"2026-09-28 12:00:05",
				);
			});
		});

		test(`round-trips to the floored second under ${tz}`, () => {
			withTZ(tz, () => {
				for (const ms of [INSTANT, INSTANT + 999, Date.UTC(2026, 0, 1, 0, 0, 0, 1)]) {
					const d = new Date(ms);
					expect(parseDbTimestamp(toDbTimestamp(d))).toBe(Math.floor(ms / 1000) * 1000);
				}
			});
		});
	}
});

test("TZ sentinel: the file leaves TZ restored", () => {
	// withTZ restores an unset TZ as "UTC", so unset and "UTC" are the same
	// state here; without this the test also failed when it ran before any
	// withTZ test had set and restored it.
	expect(process.env.TZ ?? "UTC").toBe(FILE_TZ ?? "UTC");
	// F85: when the harness itself runs with no TZ override, confirm the
	// *environment* is actually UTC (not just the env var string) — a bare
	// SQLite-shaped string parses as UTC only when the process really is.
	if (!FILE_TZ) {
		expect(Date.parse("2026-01-01 00:00:00")).toBe(Date.UTC(2026, 0, 1));
	}
});
