import { describe, expect, test } from "bun:test";
import { LATE_ARRIVAL_MS } from "../../shared/late-arrival.js";
import {
	eventDisplayTime,
	lateArrival,
	lateDetail,
	lateRunStarts,
	lateSuffix,
	timeAttribute,
} from "./event-time.js";

const STORED = "2026-11-01T12:00:00.000Z";
const storedMs = Date.parse(STORED);
const late = (ms: number) => ({
	createdAt: STORED,
	occurredAt: new Date(storedMs - ms).toISOString(),
});

describe("lateArrival", () => {
	test("exactly LATE_ARRIVAL_MS is on time; one second past is one minute late", () => {
		expect(lateArrival(late(LATE_ARRIVAL_MS))).toBeNull();
		expect(lateArrival(late(LATE_ARRIVAL_MS - 1_000))).toBeNull();
		expect(lateArrival(late(LATE_ARRIVAL_MS + 1_000))).toBe(1);
	});

	test("whole minutes, not rounded up", () => {
		expect(lateArrival(late(7 * 60_000 + 59_000))).toBe(7);
		expect(lateArrival(late(3 * 3_600_000))).toBe(180);
	});

	test("no occurrence time, an unreadable one, an unreadable stored time, or an occurrence after storage: not late", () => {
		expect(lateArrival({ createdAt: STORED })).toBeNull();
		expect(lateArrival({ createdAt: STORED, occurredAt: null })).toBeNull();
		expect(lateArrival({ createdAt: STORED, occurredAt: "last tuesday" })).toBeNull();
		expect(lateArrival({ createdAt: "garbage", occurredAt: STORED })).toBeNull();
		expect(
			lateArrival({ createdAt: STORED, occurredAt: new Date(storedMs + 5_000).toISOString() }),
		).toBeNull();
	});

	test("the SQLite stored format (no T, no Z) is read as UTC", () => {
		expect(
			lateArrival({ createdAt: "2026-11-01 12:00:00", occurredAt: "2026-11-01T11:50:00.000Z" }),
		).toBe(10);
	});
});

describe("eventDisplayTime", () => {
	test("the occurrence time when there is a readable one, else the stored time", () => {
		const occurredAt = "2026-11-01T11:30:00.000Z";
		expect(eventDisplayTime({ createdAt: STORED, occurredAt })).toBe(occurredAt);
		expect(eventDisplayTime({ createdAt: STORED })).toBe(STORED);
		expect(eventDisplayTime({ createdAt: STORED, occurredAt: null })).toBe(STORED);
		expect(eventDisplayTime({ createdAt: STORED, occurredAt: "nope" })).toBe(STORED);
	});
});

describe("lateSuffix", () => {
	test("minutes, then hours and minutes, in the relative times' units (floored)", () => {
		expect(lateSuffix(1)).toBe("arrived 1m late");
		expect(lateSuffix(7)).toBe("arrived 7m late");
		expect(lateSuffix(59)).toBe("arrived 59m late");
		expect(lateSuffix(60)).toBe("arrived 1h late");
		expect(lateSuffix(91)).toBe("arrived 1h 31m late");
		expect(lateSuffix(300)).toBe("arrived 5h late");
		expect(lateSuffix(24 * 60 + 3 * 60 + 5)).toBe("arrived 1d 3h late");
		expect(lateSuffix(2 * 24 * 60)).toBe("arrived 2d late");
	});
});

describe("lateDetail and timeAttribute", () => {
	test("the two times in words for a late event, nothing for one on time", () => {
		const detail = lateDetail(late(10 * 60_000)) as string;
		expect(detail).toMatch(/^Happened .+ · reached AgentPulse .+$/);
		expect(lateDetail({ createdAt: STORED })).toBeNull();
	});

	test("the stored form (no T, no Z) is normalized to ISO for <time dateTime>; unparseable passes through", () => {
		expect(timeAttribute("2026-11-01 12:00:00")).toBe("2026-11-01T12:00:00.000Z");
		expect(timeAttribute("2026-11-01T12:00:00.000Z")).toBe("2026-11-01T12:00:00.000Z");
		expect(timeAttribute("soon")).toBe("soon");
	});
});

describe("lateRunStarts: computed over the rows given, which are the visible ones", () => {
	const onTime = { createdAt: STORED };
	const lateRow = late(10 * 60_000);

	test("the first row of each run of late rows, and only that", () => {
		const rows = [onTime, lateRow, lateRow, lateRow, onTime, lateRow];
		expect([...lateRunStarts(rows)]).toEqual([1, 5]);
	});

	test("a run that starts the list starts at 0", () => {
		expect([...lateRunStarts([lateRow, lateRow, onTime])]).toEqual([0]);
	});

	test("filtering changes the runs: with the on-time row between two late ones removed they are one run", () => {
		const all = [lateRow, onTime, lateRow];
		expect([...lateRunStarts(all)]).toEqual([0, 2]);
		const filtered = all.filter((row) => row !== onTime);
		expect([...lateRunStarts(filtered)]).toEqual([0]);
	});

	test("rows stay in the order given, even when occurrence times run backwards across a run", () => {
		const first = { createdAt: STORED, occurredAt: "2026-11-01T11:40:00.000Z" };
		const second = { createdAt: STORED, occurredAt: "2026-11-01T11:20:00.000Z" };
		expect([...lateRunStarts([first, second])]).toEqual([0]);
	});

	test("no rows, no starts", () => {
		expect(lateRunStarts([]).size).toBe(0);
	});
});
