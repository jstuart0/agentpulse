import { describe, expect, test } from "bun:test";
import {
	AUTH_BOUNCE_WINDOW_MS,
	RETRY_BASE_MS,
	RETRY_MAX_MS,
	decideFetchFailure,
	isOutageResponse,
	parseRetryAfter,
	readLastBounce,
	recordBounce,
	retryDelayMs,
	shouldBounceForAuth,
} from "./network-retry.js";

describe("retryDelayMs", () => {
	test("doubles from the base and stops at the cap", () => {
		expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
	});

	test("never exceeds the cap however many attempts have failed", () => {
		expect(retryDelayMs(40)).toBe(RETRY_MAX_MS);
		expect(retryDelayMs(10_000)).toBe(RETRY_MAX_MS);
	});

	test("a nonsense attempt number waits the base delay", () => {
		expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
		expect(retryDelayMs(-3)).toBe(RETRY_BASE_MS);
		expect(retryDelayMs(Number.NaN)).toBe(RETRY_BASE_MS);
	});
});

describe("shouldBounceForAuth", () => {
	const now = 1_000_000;

	test("the first failure of a visit may reload once to pick up a fresh sign-in", () => {
		expect(shouldBounceForAuth(null, now)).toBe(true);
	});

	test("a second failure inside the window is an outage, not an expired session", () => {
		expect(shouldBounceForAuth(now - 1_000, now)).toBe(false);
		expect(shouldBounceForAuth(now - (AUTH_BOUNCE_WINDOW_MS - 1), now)).toBe(false);
	});

	test("after the window a reload is allowed again", () => {
		expect(shouldBounceForAuth(now - AUTH_BOUNCE_WINDOW_MS, now)).toBe(true);
	});

	test("a timestamp from the future (clock moved) doesn't allow another reload", () => {
		expect(shouldBounceForAuth(now + 5_000, now)).toBe(false);
	});
});

describe("decideFetchFailure", () => {
	test("no earlier reload: reload", () => {
		expect(decideFetchFailure({ lastBounceAt: null, now: 5_000 })).toEqual({
			action: "reload",
		});
	});

	test("a recent reload: retry, paced by the notice's probes", () => {
		expect(decideFetchFailure({ lastBounceAt: 4_000, now: 5_000 })).toEqual({ action: "retry" });
	});
});

describe("parseRetryAfter", () => {
	const now = Date.UTC(2026, 9, 2, 12, 0, 0);

	test("a number of seconds", () => {
		expect(parseRetryAfter("900", now)).toBe(900);
		expect(parseRetryAfter(" 60 ", now)).toBe(60);
	});

	test("an HTTP date is the seconds from now, rounded up", () => {
		expect(parseRetryAfter("Fri, 02 Oct 2026 12:15:00 GMT", now)).toBe(900);
		expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:00 GMT", now + 500)).toBeNull();
	});

	test("an HTTP date counts a started second as a whole one", () => {
		expect(parseRetryAfter("Fri, 02 Oct 2026 12:01:00 GMT", now + 400)).toBe(60);
		expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:30 GMT", now + 999)).toBe(30);
		expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:30 GMT", now + 1)).toBe(30);
	});

	test("absent, empty, negative, fractional or unreadable is null", () => {
		for (const bad of [null, "", "-5", "1.5", "soon", "0"]) {
			expect(parseRetryAfter(bad, now)).toBeNull();
		}
	});
});

describe("parseRetryAfter bounds and forms", () => {
	const now = Date.UTC(1994, 10, 6, 8, 49, 0);

	test("a wait longer than an hour is not believed: no number, so the generic message is used", () => {
		expect(parseRetryAfter("3600", now)).toBe(3600);
		expect(parseRetryAfter("3601", now)).toBeNull();
		expect(parseRetryAfter("99999999999999999999999", now)).toBeNull();
	});

	test("a date more than an hour away is not believed either", () => {
		expect(parseRetryAfter("Sun, 06 Nov 1994 10:49:01 GMT", now)).toBeNull();
		expect(parseRetryAfter("Sun, 06 Nov 1994 09:49:00 GMT", now)).toBe(3600);
	});

	test("a value that is not a finite number is ignored", () => {
		expect(parseRetryAfter("Infinity", now)).toBeNull();
		expect(parseRetryAfter("1e999", now)).toBeNull();
		expect(parseRetryAfter("NaN", now)).toBeNull();
	});

	test("the asctime date form is read as UTC, whatever the browser's time zone", () => {
		const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
				process.env.TZ = tz;
				expect(parseRetryAfter("Sun Nov  6 08:50:37 1994", now)).toBe(97);
			}
		} finally {
			process.env.TZ = zone;
		}
	});

	test("the other two date forms keep working", () => {
		expect(parseRetryAfter("Sun, 06 Nov 1994 08:50:37 GMT", now)).toBe(97);
		expect(parseRetryAfter("Sunday, 06-Nov-94 08:50:37 GMT", now)).toBe(97);
	});
});

describe("when session storage is unavailable", () => {
	const throwing = {
		getItem: () => {
			throw new Error("SecurityError");
		},
		setItem: () => {
			throw new Error("QuotaExceededError");
		},
	};

	test("the last reload can't be read, which is not 'never reloaded'", () => {
		expect(readLastBounce(throwing)).toBe("unavailable");
	});

	test("a failed request is an outage (retry), never a reload", () => {
		const lastBounceAt = readLastBounce(throwing);
		expect(decideFetchFailure({ lastBounceAt, now: 5_000 })).toEqual({ action: "retry" });
	});

	test("a reload time that can't be stored is reported as not stored", () => {
		expect(recordBounce(throwing, 5_000)).toBe(false);
	});

	test("working storage still reads and records", () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		};
		expect(readLastBounce(storage)).toBeNull();
		expect(recordBounce(storage, 7_000)).toBe(true);
		expect(readLastBounce(storage)).toBe(7_000);
	});
});

describe("isOutageResponse (AGEN-69 phase 8a)", () => {
	test("BN-27 a deliberate 503 busy or shutting_down answer is not an outage", () => {
		expect(isOutageResponse(503, "busy", "/ai/sessions/s1/summary")).toBe(false);
		expect(isOutageResponse(503, "shutting_down", "/ai/sessions/s1/summary")).toBe(false);
	});

	test("a gateway error without those codes is still an outage, on any path", () => {
		for (const status of [502, 503, 504]) {
			expect(isOutageResponse(status, null, "/sessions")).toBe(true);
			expect(isOutageResponse(status, "something_else", "/sessions")).toBe(true);
		}
		expect(isOutageResponse(500, null, "/sessions")).toBe(false);
		expect(isOutageResponse(409, "ai_paused", "/sessions")).toBe(false);
	});

	test("the identity check treats every 5xx and 429 as an outage, even a busy one", () => {
		expect(isOutageResponse(503, "shutting_down", "/auth/me")).toBe(true);
		expect(isOutageResponse(429, null, "/auth/me")).toBe(true);
		expect(isOutageResponse(401, null, "/auth/me")).toBe(false);
	});
});
