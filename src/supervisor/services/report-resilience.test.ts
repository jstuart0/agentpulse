/**
 * F31/D7 (2026-09-29-deliver-supervisor-auth-routing): a 401 (credential
 * revoked or rotated) must be fatal — reportInSessionSafely invokes its
 * onFatal callback and stops. A 403 (session_not_owned) or any 5xx must
 * log and continue, exactly like before D7.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	BACKOFF_BUDGET_MS,
	MIN_RETRY_AFTER_MS,
	type ReportFailureClass,
	SupervisorNetworkError,
	SupervisorRequestError,
	__resetHostRefusalNoteForTests,
	classifyReportFailure,
	createCredentialTripwire,
	credentialRejectionMayConfirm,
	isCredentialRejected,
	markCredentialHandled,
	noteHostRefusal,
	parseRetryAfterMs,
	reportInSessionSafely,
	sessionBackoffMs,
	setSharedCredentialTripwire,
} from "./report-resilience.js";

describe("SupervisorRequestError / isCredentialRejected", () => {
	test("a 401 in one of the server's credential wordings is a credential rejection; a bare 401 (a proxy's) is not", () => {
		expect(
			isCredentialRejected(
				new SupervisorRequestError(401, "Unauthorized", "Invalid supervisor credential"),
			),
		).toBe(true);
		expect(isCredentialRejected(new SupervisorRequestError(401, "Unauthorized"))).toBe(false);
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

const CREDENTIAL = () =>
	new SupervisorRequestError(401, "Unauthorized", "Invalid supervisor credential");

describe("reportInSessionSafely: a confirmed credential rejection is fatal, anything else logs and continues (F31/D7, AGEN-83)", () => {
	afterEach(() => setSharedCredentialTripwire(null));

	function armed(gapMs: number) {
		let clock = 5_000_000;
		setSharedCredentialTripwire(createCredentialTripwire({ now: () => clock }));
		return {
			advance: () => {
				clock += gapMs;
			},
		};
	}

	test("one credential rejection only waits for a second: onFatal is not invoked", async () => {
		armed(0);
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-1",
			"reportState",
			async () => {
				throw CREDENTIAL();
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("a second at least 10 s later invokes onFatal and resolves (doesn't throw)", async () => {
		const clock = armed(10_000);
		let fatalCalls = 0;
		const run = () =>
			reportInSessionSafely(
				"test-scope",
				"sess-1",
				"reportState",
				async () => {
					throw CREDENTIAL();
				},
				() => {
					fatalCalls++;
				},
			);
		await run();
		expect(fatalCalls).toBe(0);
		clock.advance();
		await run();
		expect(fatalCalls).toBe(1);
	});

	test("a second within 10 s does not", async () => {
		const clock = armed(9_900);
		let fatalCalls = 0;
		const run = () =>
			reportInSessionSafely(
				"t",
				"s",
				"o",
				async () => {
					throw CREDENTIAL();
				},
				() => {
					fatalCalls++;
				},
			);
		await run();
		clock.advance();
		await run();
		expect(fatalCalls).toBe(0);
	});

	test("a bare 401 (no credential wording) never counts, however often", async () => {
		const clock = armed(60_000);
		let fatalCalls = 0;
		for (let i = 0; i < 4; i++) {
			await reportInSessionSafely(
				"t",
				"s",
				"o",
				async () => {
					throw new SupervisorRequestError(401, "Unauthorized");
				},
				() => {
					fatalCalls++;
				},
			);
			clock.advance();
		}
		expect(fatalCalls).toBe(0);
	});

	test("a rejection the report gate already counted is only logged: it is not counted a second time", async () => {
		const clock = armed(10_000);
		let fatalCalls = 0;
		const handled = CREDENTIAL();
		markCredentialHandled(handled);
		await reportInSessionSafely(
			"t",
			"s",
			"o",
			async () => {
				throw handled;
			},
			() => {
				fatalCalls++;
			},
		);
		clock.advance();
		await reportInSessionSafely(
			"t",
			"s",
			"o",
			async () => {
				throw handled;
			},
			() => {
				fatalCalls++;
			},
		);
		expect(fatalCalls, "handled errors never reach onFatal here").toBe(0);
		// and they did not use up the tripwire's first record: the next unhandled one is a first
		await reportInSessionSafely(
			"t",
			"s",
			"o",
			async () => {
				throw CREDENTIAL();
			},
			() => {
				fatalCalls++;
			},
		);
		expect(fatalCalls).toBe(0);
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

	test("onFatal is NOT invoked for a 403", async () => {
		let fatal = 0;
		await reportInSessionSafely(
			"test-scope",
			"sess-7",
			"reportState",
			async () => {
				throw new SupervisorRequestError(403, "Forbidden");
			},
			() => void fatal++,
		);
		expect(fatal).toBe(0);
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
		["413 payload_too_large", http(413, "payload_too_large"), "entry"],
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

describe("credentialRejectionMayConfirm: every scheme and host", () => {
	const CASES: Array<[string, boolean]> = [
		["https://agentpulse.example.com", true],
		["https://agentpulse.example.com:8443/base", true],
		["https://10.1.2.3", true],
		["HTTPS://EXAMPLE.COM", true],
		["http://localhost", true],
		["http://localhost:3000", true],
		["http://LOCALHOST:3000", true],
		["http://127.0.0.1", true],
		["http://127.0.0.1:3000", true],
		["http://127.1.2.3", true],
		["http://[::1]", true],
		["http://[::1]:3000", true],
		["http://agentpulse.example.com", false],
		["http://10.0.0.5:3000", false],
		["http://192.168.1.10", false],
		["http://0.0.0.0", false],
		["http://localhost.evil.example", false],
		["http://127.0.0.1.evil.example", false],
		["http://evil.example/127.0.0.1", false],
		["http://user@evil.example@127.0.0.1", true],
		["http://128.0.0.1", false],
		["http://[::2]", false],
		["http://[2001:db8::1]", false],
		["ftp://localhost", false],
		["ws://localhost", false],
		["wss://agentpulse.example.com", false],
		["file:///etc/passwd", false],
		["localhost:3000", false],
		["not a url", false],
		["", false],
	];
	for (const [url, expected] of CASES) {
		test(`${JSON.stringify(url)} -> ${expected}`, () => {
			expect(credentialRejectionMayConfirm(url)).toBe(expected);
		});
	}

	test("a missing url never confirms", () => {
		expect(credentialRejectionMayConfirm(undefined)).toBe(false);
		expect(credentialRejectionMayConfirm(null)).toBe(false);
	});

	test("a tripwire told it may not confirm never does, however far apart the rejections, and says so once", () => {
		let clock = 0;
		const lines: string[] = [];
		const wire = createCredentialTripwire({
			now: () => clock,
			canConfirm: false,
			log: (line) => lines.push(line),
		});
		for (let i = 0; i < 5; i++) {
			clock += 60_000;
			expect(wire.record()).toBe("first");
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("not acting on it");
		// the same wire built the normal way does confirm: the refusal is the option's doing
		let t = 0;
		const normal = createCredentialTripwire({ now: () => t, canConfirm: true });
		normal.record();
		t = 10_000;
		expect(normal.record()).toBe("confirmed");
	});
});

describe("sessionBackoffMs", () => {
	const mid = () => 0.5; // jitter factor 1.0

	test("3, 6, 12, 24, 48, 60, 60 seconds", () => {
		expect([0, 1, 2, 3, 4, 5, 6].map((k) => sessionBackoffMs(k, undefined, mid))).toEqual([
			3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
		]);
	});

	test("jitter stays within 20% either way", () => {
		for (const k of [0, 3, 6]) {
			const base = Math.min(60_000, 3_000 * 2 ** k);
			expect(sessionBackoffMs(k, undefined, () => 0)).toBe(Math.round(base * 0.8));
			expect(sessionBackoffMs(k, undefined, () => 0.999999)).toBeLessThanOrEqual(
				Math.round(base * 1.2),
			);
		}
	});

	test("a longer Retry-After wins, a shorter one does not shorten the wait", () => {
		expect(sessionBackoffMs(0, 120_000, mid)).toBe(120_000);
		expect(sessionBackoffMs(3, 1_000, mid)).toBe(24_000);
	});

	test("a very large failure count doesn't overflow", () => {
		expect(sessionBackoffMs(10_000, undefined, mid)).toBe(60_000);
	});

	test("the cumulative budget is six hours", () => {
		expect(BACKOFF_BUDGET_MS).toBe(6 * 3_600_000);
	});
});

describe("noteHostRefusal (AGEN-92)", () => {
	afterEach(() => __resetHostRefusalNoteForTests());
	const refused = (message?: string) =>
		new SupervisorRequestError(403, "Forbidden", "bad_origin", undefined, message);

	test("a 403 bad_origin is logged once per process, in the server's words", () => {
		__resetHostRefusalNoteForTests();
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			noteHostRefusal(refused("Only localhost."));
			noteHostRefusal(refused("Only localhost."));
			expect(log).toHaveBeenCalledTimes(1);
			expect(String(log.mock.calls[0]?.[0])).toContain("Only localhost.");
		} finally {
			log.mockRestore();
		}
	});

	test("other refusals say nothing, and it is still back-pressure, never the credential tripwire", () => {
		__resetHostRefusalNoteForTests();
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			noteHostRefusal(new SupervisorRequestError(403, "Forbidden", "session_not_owned"));
			noteHostRefusal(new SupervisorRequestError(401, "Unauthorized", "bad_origin"));
			noteHostRefusal(new Error("x"));
			expect(log).not.toHaveBeenCalled();
			expect(classifyReportFailure(refused("m"))).not.toBe("credential");
		} finally {
			log.mockRestore();
		}
	});
});
