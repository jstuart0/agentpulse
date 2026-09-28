import { beforeEach, describe, expect, test } from "bun:test";
import { RATE_LIMIT_CAPACITY, _resetBucketsForTest, tryConsume } from "./hook-rate-limit.js";

beforeEach(() => {
	_resetBucketsForTest();
});

/**
 * F84 (tessa mid-build, recommended): the integration-tier rate-limit test
 * (sessions-native-name-scope.test.ts) loops up to 300 real, DB-backed
 * calls and asserts "a 429 happens somewhere in that margin" — correct for
 * proving the wiring, but it can't pin the exact capacity boundary because
 * wall-clock time spent per real request refills a few tokens back mid-loop
 * (the bucket's own correct, intentional design). This test pins one exact
 * instant with a fake clock, so a capacity regression (RATE_LIMIT_CAPACITY
 * drifting, or an off-by-one in the >=1 check) fails here even if it's
 * within the integration test's margin.
 */
describe("tryConsume — exact capacity boundary at one fixed instant (F84)", () => {
	test(`the ${RATE_LIMIT_CAPACITY}th call consumes; the ${RATE_LIMIT_CAPACITY + 1}th is rejected at the same instant (zero refill)`, () => {
		const now = () => 1_000_000; // frozen — no elapsed time between calls
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
			expect(tryConsume("boundary-key", now)).toBe(true);
		}
		expect(tryConsume("boundary-key", now)).toBe(false);
		// Still frozen: the rejection isn't a fluke of timing — a second call
		// at the identical instant is rejected too.
		expect(tryConsume("boundary-key", now)).toBe(false);
	});

	test("a later instant refills proportionally, not fully, and consumes exactly one token per call", () => {
		let currentMs = 2_000_000;
		const now = () => currentMs;
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
			expect(tryConsume("refill-key", now)).toBe(true);
		}
		expect(tryConsume("refill-key", now)).toBe(false);

		// Exactly 500ms later: half the per-second capacity refills.
		currentMs += 500;
		let allowed = 0;
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
			if (tryConsume("refill-key", now)) allowed++;
		}
		expect(allowed).toBe(Math.floor(RATE_LIMIT_CAPACITY / 2));
	});

	test("independent keys have independent buckets at the same instant", () => {
		const now = () => 3_000_000;
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
			expect(tryConsume("key-a", now)).toBe(true);
		}
		expect(tryConsume("key-a", now)).toBe(false);
		// key-b's bucket is untouched by key-a's exhaustion.
		expect(tryConsume("key-b", now)).toBe(true);
	});
});
