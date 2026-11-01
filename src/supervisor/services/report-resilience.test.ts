/**
 * F31/D7 (2026-09-29-deliver-supervisor-auth-routing): a 401 (credential
 * revoked or rotated) must be fatal — reportInSessionSafely invokes its
 * onFatal callback and stops. A 403 (session_not_owned) or any 5xx must
 * log and continue, exactly like before D7.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
	MIN_RETRY_AFTER_MS,
	type ReportFailureClass,
	SupervisorNetworkError,
	SupervisorRequestError,
	classifyReportFailure,
	createCredentialTripwire,
	isCredentialRejected,
	parseRetryAfterMs,
	reportInSessionSafely,
} from "./report-resilience.js";

describe("SupervisorRequestError / isCredentialRejected", () => {
	test("401 is a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(401, "Unauthorized"))).toBe(true);
	});

	test("403 is not a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(403, "Forbidden"))).toBe(false);
	});

	test("500 is not a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(500, "Internal Server Error"))).toBe(
			false,
		);
	});

	test("a non-SupervisorRequestError is never a credential rejection", () => {
		expect(isCredentialRejected(new Error("network error"))).toBe(false);
		expect(isCredentialRejected("not even an error")).toBe(false);
		expect(isCredentialRejected(undefined)).toBe(false);
	});

	test("carries the status and a human-readable message", () => {
		const error = new SupervisorRequestError(401, "Unauthorized");
		expect(error.status).toBe(401);
		expect(error.message).toBe("Supervisor request failed: 401 Unauthorized");
		expect(error.name).toBe("SupervisorRequestError");
		expect(error).toBeInstanceOf(Error);
	});
});

describe("reportInSessionSafely — 401 is fatal, 403/5xx log-and-continue (F31/D7)", () => {
	test("a 401 invokes onFatal and resolves (doesn't throw)", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-1",
			"reportState",
			async () => {
				throw new SupervisorRequestError(401, "Unauthorized");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(true);
	});

	test("a 403 (session_not_owned) logs and continues — onFatal is not invoked", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-2",
			"reportState",
			async () => {
				throw new SupervisorRequestError(403, "Forbidden");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("a 500 logs and continues — onFatal is not invoked", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-3",
			"reportState",
			async () => {
				throw new SupervisorRequestError(500, "Internal Server Error");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("an unrelated error (e.g. network failure) also logs and continues", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-4",
			"reportState",
			async () => {
				throw new Error("fetch failed");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("success never invokes onFatal", async () => {
		let fatalCalled = false;
		let ran = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-5",
			"reportState",
			async () => {
				ran = true;
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(ran).toBe(true);
		expect(fatalCalled).toBe(false);
	});

	test("defaults onFatal to process.exit(1) when the caller doesn't supply one (mocked)", async () => {
		const exitSpy = spyOn(process, "exit").mockImplementation(
			(() => undefined) as unknown as typeof process.exit,
		);
		try {
			await reportInSessionSafely("test-scope", "sess-6", "reportState", async () => {
				throw new SupervisorRequestError(401, "Unauthorized");
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("the default onFatal is NOT invoked for a 403 (mocked process.exit stays uncalled)", async () => {
		const exitSpy = spyOn(process, "exit").mockImplementation(
			(() => undefined) as unknown as typeof process.exit,
		);
		try {
			await reportInSessionSafely("test-scope", "sess-7", "reportState", async () => {
				throw new SupervisorRequestError(403, "Forbidden");
			});
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("classifyReportFailure (AGEN-83 D8)", () => {
	const http = (status: number, error?: string, retryAfterMs?: number) =>
		new SupervisorRequestError(status, "x", error, retryAfterMs);

	const ROWS: Array<[string, unknown, ReportFailureClass]> = [
		[
			"a fetch rejection or timeout",
			new SupervisorNetworkError(new TypeError("fetch failed")),
			"network",
		],
		["401 Missing supervisor credential", http(401, "Missing supervisor credential"), "credential"],
		["401 Invalid supervisor credential", http(401, "Invalid supervisor credential"), "credential"],
		[
			"403 Supervisor credential does not match target supervisor",
			http(403, "Supervisor credential does not match target supervisor"),
			"credential",
		],
		["403 session_not_owned", http(403, "session_not_owned"), "session"],
		["400 reserved_event_type", http(400, "reserved_event_type"), "entry"],
		["400 invalid_body", http(400, "invalid_body"), "entry"],
		["400 sessionId is required", http(400, "sessionId is required"), "entry"],
		["408", http(408), "server"],
		["425", http(425), "server"],
		["429", http(429, "rate_limited"), "server"],
		["500", http(500), "server"],
		["502", http(502), "server"],
		["503 without Retry-After", http(503, "busy"), "server"],
		["503 with Retry-After but another body", http(503, "overloaded", 2_000), "server"],
		["503 with Retry-After and no body error", http(503, undefined, 2_000), "server"],
		["599", http(599), "server"],
		["404", http(404, "Launch request not found"), "stop"],
		["413 payload_too_large", http(413, "payload_too_large"), "stop"],
		["a 400 with another body", http(400, "something_else"), "stop"],
		["a 400 with no body error", http(400), "stop"],
		["a 422", http(422), "stop"],
		["a 401 with an unknown body", http(401, "Unauthorized"), "stop"],
		["a 401 with no body", http(401), "stop"],
		["a 403 with an unknown body", http(403, "Forbidden"), "stop"],
		["a 403 with no body", http(403), "stop"],
		[
			"a 401 whose text is only close to the real one",
			http(401, "invalid supervisor credential"),
			"stop",
		],
	];
	for (const [label, error, expected] of ROWS) {
		test(`${label} is ${expected}`, () => {
			expect(classifyReportFailure(error)).toBe(expected);
		});
	}

	test("a 503 carrying Retry-After (the replay cap's busy) is back-pressure, a class of its own that is not `server`", () => {
		expect(classifyReportFailure(http(503, "busy", 2_000))).toBe("backoff");
		// the same status without the header is an ordinary server failure that counts
		expect(classifyReportFailure(http(503, "busy"))).toBe("server");
		// Retry-After on a 5xx other than 503, or on a 429, doesn't make it back-pressure
		expect(classifyReportFailure(http(500, undefined, 2_000))).toBe("server");
		expect(classifyReportFailure(http(429, undefined, 2_000))).toBe("server");
	});

	test("an error raised outside the request is not a delivery failure, and in particular not `network`", () => {
		expect(classifyReportFailure(new TypeError("x is not a function"))).toBe("other");
		expect(classifyReportFailure(new SyntaxError("Unexpected token"))).toBe("other");
		expect(classifyReportFailure(new Error("boom"))).toBe("other");
		expect(classifyReportFailure("a string")).toBe("other");
		expect(classifyReportFailure(undefined)).toBe("other");
	});

	test("the credential strings match exactly: the body's own error field, not the status text", () => {
		const e = new SupervisorRequestError(401, "Invalid supervisor credential");
		expect(classifyReportFailure(e)).toBe("stop");
	});

	test("SupervisorNetworkError names the failure kind but never a URL or message of the cause", () => {
		const e = new SupervisorNetworkError(
			Object.assign(new TypeError("connect ECONNREFUSED http://10.0.0.5/secret"), {}),
		);
		expect(e.message).toBe("Supervisor request failed: network error (TypeError)");
		expect(e).not.toBeInstanceOf(SupervisorRequestError);
		expect(isCredentialRejected(e)).toBe(false);
	});
});

describe("parseRetryAfterMs", () => {
	const NOW = Date.parse("2026-11-01T12:00:00Z");

	test("delta-seconds", () => {
		expect(parseRetryAfterMs("2", NOW)).toBe(2_000);
	});

	test("never less than a second: Retry-After 0, or a date that is a moment away, still pauses", () => {
		expect(MIN_RETRY_AFTER_MS).toBe(1_000);
		expect(parseRetryAfterMs(" 0 ", NOW)).toBe(1_000);
		expect(parseRetryAfterMs("1", NOW)).toBe(1_000);
		expect(parseRetryAfterMs("Sun, 01 Nov 2026 12:00:00 GMT", NOW)).toBe(1_000);
		expect(parseRetryAfterMs("Sun, 01 Nov 2026 12:00:01 GMT", NOW)).toBe(1_000);
		expect(parseRetryAfterMs("Sun, 01 Nov 2026 12:00:02 GMT", NOW)).toBe(2_000);
	});

	test("an HTTP date is read relative to now", () => {
		expect(parseRetryAfterMs("Sun, 01 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
	});

	test("a date in the past, a negative, junk and a missing header give undefined", () => {
		for (const value of [
			"Sun, 01 Nov 2026 11:00:00 GMT",
			"-5",
			"soon",
			"",
			"1.5",
			null,
			undefined,
		]) {
			expect(parseRetryAfterMs(value, NOW), String(value)).toBeUndefined();
		}
	});

	test("anything over an hour is capped at an hour", () => {
		expect(parseRetryAfterMs("3600", NOW)).toBe(3_600_000);
		expect(parseRetryAfterMs("3601", NOW)).toBe(3_600_000);
		expect(parseRetryAfterMs("99999999999", NOW)).toBe(3_600_000);
		expect(parseRetryAfterMs("Mon, 01 Nov 2027 12:00:00 GMT", NOW)).toBe(3_600_000);
	});
});

describe("createCredentialTripwire", () => {
	function tripwire() {
		let now = 1_000_000;
		const wire = createCredentialTripwire({ now: () => now });
		return {
			wire,
			at: (ms: number) => {
				now = 1_000_000 + ms;
			},
		};
	}

	test("the first rejection is only recorded", () => {
		const { wire } = tripwire();
		expect(wire.record()).toBe("first");
	});

	test("a second 10 s or more after the first confirms; 9.9 s does not", () => {
		const { wire, at } = tripwire();
		expect(wire.record()).toBe("first");
		at(9_900);
		expect(wire.record()).toBe("first");
		at(10_000);
		expect(wire.record()).toBe("confirmed");
	});

	test("the gap is measured from the first, not slid forward by an early second", () => {
		const { wire, at } = tripwire();
		wire.record();
		at(5_000);
		expect(wire.record()).toBe("first");
		at(10_000);
		expect(wire.record(), "10 s after the first, though only 5 s after the second").toBe(
			"confirmed",
		);
	});

	test("a success in between (reset) forgets the first", () => {
		const { wire, at } = tripwire();
		wire.record();
		at(8_000);
		wire.reset();
		at(30_000);
		expect(wire.record(), "a fresh first, not a confirmation").toBe("first");
		at(40_000);
		expect(wire.record()).toBe("confirmed");
	});

	test("the minimum gap can be set", () => {
		let now = 0;
		const wire = createCredentialTripwire({ now: () => now, minGapMs: 100 });
		wire.record();
		now = 99;
		expect(wire.record()).toBe("first");
		now = 100;
		expect(wire.record()).toBe("confirmed");
	});
});
