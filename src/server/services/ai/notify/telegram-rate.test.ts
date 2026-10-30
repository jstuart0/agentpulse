import { describe, expect, test } from "bun:test";
import "../__test_db.js";
import {
	NOTIFY_ESCALATIONS_PER_SESSION_PER_HOUR,
	NOTIFY_TELEGRAM_MIN_INTERVAL_MS,
	type TelegramDecisionInput,
	telegramDecision,
} from "./telegram-rate.js";

const { NOTIFY_TELEGRAM_GLOBAL_PER_HOUR } = await import("../../channels/telegram-budget.js");

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const decide = (over: Partial<TelegramDecisionInput>) =>
	telegramDecision({
		verdict: "finished",
		lastRoutineSentAt: null,
		escalationsLastHour: 0,
		globalLastHour: 0,
		now: NOW,
		...over,
	});

describe("routine reports (finished)", () => {
	test("5 minutes after one was sent is skipped; 11 minutes after is sent", () => {
		expect(decide({ lastRoutineSentAt: NOW - 5 * MIN })).toBe("skipped_rate_limit");
		expect(decide({ lastRoutineSentAt: NOW - 11 * MIN })).toBe("send");
	});

	test("the boundary: exactly the interval after is sent, a millisecond less is skipped", () => {
		expect(decide({ lastRoutineSentAt: NOW - NOTIFY_TELEGRAM_MIN_INTERVAL_MS })).toBe("send");
		expect(decide({ lastRoutineSentAt: NOW - NOTIFY_TELEGRAM_MIN_INTERVAL_MS + 1 })).toBe(
			"skipped_rate_limit",
		);
	});

	test("the first one for a session is sent", () => {
		expect(decide({ lastRoutineSentAt: null })).toBe("send");
	});
});

describe("escalations (stuck, needs_you)", () => {
	test("D-C: needs_you one minute after a sent needs_you is sent (a new turn)", () => {
		expect(
			decide({ verdict: "needs_you", lastRoutineSentAt: NOW - MIN, escalationsLastHour: 1 }),
		).toBe("send");
	});

	test("stuck one minute after a sent finished is sent", () => {
		expect(decide({ verdict: "stuck", lastRoutineSentAt: NOW - MIN })).toBe("send");
	});

	test("the 4th escalation for one session within an hour is skipped; another session's is sent", () => {
		expect(NOTIFY_ESCALATIONS_PER_SESSION_PER_HOUR).toBe(3);
		expect(decide({ verdict: "needs_you", escalationsLastHour: 3 })).toBe("skipped_rate_limit");
		expect(decide({ verdict: "stuck", escalationsLastHour: 2 })).toBe("send");
		expect(decide({ verdict: "needs_you", escalationsLastHour: 0 })).toBe("send");
	});
});

describe("the global cap", () => {
	test("at 30 in the last hour both a routine and an escalation are skipped; at 29 they are sent", () => {
		expect(NOTIFY_TELEGRAM_GLOBAL_PER_HOUR).toBe(30);
		expect(decide({ globalLastHour: 30 })).toBe("skipped_rate_limit");
		expect(decide({ verdict: "needs_you", globalLastHour: 30 })).toBe("skipped_rate_limit");
		expect(decide({ globalLastHour: 29 })).toBe("send");
		expect(decide({ verdict: "needs_you", globalLastHour: 29 })).toBe("send");
	});
});
