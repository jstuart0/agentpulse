/**
 * codex r2 F43 (2026-09-29-deliver-supervisor-auth-routing, D10): initial
 * registration must retry forever on an HTTP failure instead of exiting.
 */
import { describe, expect, mock, test } from "bun:test";
import {
	REGISTRATION_MAX_DELAY_MS,
	computeBackoffDelay,
	retryWithBackoff,
} from "./registration-retry.js";
import { SupervisorNetworkError, SupervisorRequestError } from "./report-resilience.js";

describe("computeBackoffDelay", () => {
	test("starts around 5s at attempt 0", () => {
		for (let i = 0; i < 20; i++) {
			const delay = computeBackoffDelay(0);
			expect(delay).toBeGreaterThanOrEqual(2_500);
			expect(delay).toBeLessThanOrEqual(5_000);
		}
	});

	test("grows monotonically before the cap (equal-jitter floor guarantee)", () => {
		for (let trial = 0; trial < 20; trial++) {
			let previous = 0;
			for (let attempt = 0; attempt <= 5; attempt++) {
				const delay = computeBackoffDelay(attempt);
				expect(delay).toBeGreaterThanOrEqual(previous);
				previous = delay;
			}
		}
	});

	test("is capped at 5 minutes for a large attempt count", () => {
		for (let i = 0; i < 20; i++) {
			const delay = computeBackoffDelay(20);
			expect(delay).toBeLessThanOrEqual(REGISTRATION_MAX_DELAY_MS);
			expect(delay).toBeGreaterThanOrEqual(REGISTRATION_MAX_DELAY_MS / 2);
		}
	});
});

describe("retryWithBackoff", () => {
	test("403 insufficient_scope, then 401, then success — registers on the third attempt without exiting; delays grow and are capped", async () => {
		let callCount = 0;
		const fn = async () => {
			callCount++;
			if (callCount === 1) {
				throw new SupervisorRequestError(403, "Forbidden", "insufficient_scope");
			}
			if (callCount === 2) {
				throw new SupervisorRequestError(401, "Unauthorized");
			}
			return { supervisor: { id: "sup-1", hostName: "host-1" } };
		};

		const failures: Array<{ status: number; attempt: number; delayMs: number }> = [];
		const sleepCalls: number[] = [];
		const onRetryableFailure = mock(
			(
				error: SupervisorRequestError | SupervisorNetworkError,
				attempt: number,
				delayMs: number,
			) => {
				if (error instanceof SupervisorRequestError) {
					failures.push({ status: error.status, attempt, delayMs });
				}
			},
		);

		const result = await retryWithBackoff(fn, onRetryableFailure, {
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
			computeDelay: (attempt) => [5_000, 10_000][attempt] ?? REGISTRATION_MAX_DELAY_MS,
		});

		expect(result).toEqual({ supervisor: { id: "sup-1", hostName: "host-1" } });
		expect(callCount).toBe(3);
		expect(onRetryableFailure).toHaveBeenCalledTimes(2);
		expect(failures.map((f) => f.status)).toEqual([403, 401]);
		expect(sleepCalls).toEqual([5_000, 10_000]);
		expect(sleepCalls[1]).toBeGreaterThan(sleepCalls[0]);
		expect(sleepCalls.every((d) => d <= REGISTRATION_MAX_DELAY_MS)).toBe(true);
	});

	test("a non-SupervisorRequestError (config/parse failure) is never retried and propagates immediately", async () => {
		const fn = async () => {
			throw new Error("failed to load supervisor config");
		};
		const onRetryableFailure = mock(() => {});

		await expect(
			retryWithBackoff(fn, onRetryableFailure, {
				sleep: async () => {},
				computeDelay: () => 0,
			}),
		).rejects.toThrow("failed to load supervisor config");
		expect(onRetryableFailure).not.toHaveBeenCalled();
	});

	test("succeeds on the first attempt without ever calling sleep", async () => {
		const fn = async () => "ok";
		const sleep = mock(async () => {});
		const result = await retryWithBackoff(fn, () => {}, {
			sleep,
			computeDelay: () => 1,
		});
		expect(result).toBe("ok");
		expect(sleep).not.toHaveBeenCalled();
	});

	test("the server unreachable, then reachable: registration retries through the network errors and succeeds without throwing", async () => {
		let callCount = 0;
		const fn = async () => {
			callCount++;
			if (callCount <= 3) {
				throw new SupervisorNetworkError(new TypeError("fetch failed"));
			}
			return { supervisor: { id: "sup-1", hostName: "host-1" } };
		};
		const seen: string[] = [];
		const sleepCalls: number[] = [];
		const result = await retryWithBackoff(
			fn,
			(error, attempt) => {
				seen.push(`${attempt}:${error instanceof SupervisorNetworkError ? "network" : "http"}`);
			},
			{
				sleep: async (ms) => {
					sleepCalls.push(ms);
				},
				computeDelay: (attempt) => 1_000 * (attempt + 1),
			},
		);
		expect(result).toEqual({ supervisor: { id: "sup-1", hostName: "host-1" } });
		expect(callCount).toBe(4);
		expect(seen).toEqual(["0:network", "1:network", "2:network"]);
		expect(sleepCalls).toEqual([1_000, 2_000, 3_000]);
	});

	test("an outage that mixes unreachable and an HTTP answer keeps retrying through both", async () => {
		const answers: Array<() => never | string> = [
			() => {
				throw new SupervisorNetworkError();
			},
			() => {
				throw new SupervisorRequestError(502, "Bad Gateway");
			},
			() => {
				throw new SupervisorNetworkError();
			},
			() => "registered",
		];
		let i = 0;
		const result = await retryWithBackoff(
			async () => (answers[i++] as () => string)(),
			() => {},
			{ sleep: async () => {}, computeDelay: () => 0 },
		);
		expect(result).toBe("registered");
		expect(i).toBe(4);
	});

	test("an error that is neither (a TypeError raised in the caller, a malformed body) is still fatal", async () => {
		for (const failure of [new TypeError("x is not a function"), new SyntaxError("bad json")]) {
			const onRetryableFailure = mock(() => {});
			await expect(
				retryWithBackoff(
					async () => {
						throw failure;
					},
					onRetryableFailure,
					{ sleep: async () => {}, computeDelay: () => 0 },
				),
			).rejects.toBe(failure);
			expect(onRetryableFailure).not.toHaveBeenCalled();
		}
	});
});
