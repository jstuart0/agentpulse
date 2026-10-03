import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	RATE_LIMIT_CAPACITY,
	_resetBucketsForTest,
	_setBucketCapForTest,
	_setRateLimitClockForTest,
	_trackedBucketsForTest,
	hookRateLimit,
	tryConsume,
} from "./hook-rate-limit.js";

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

describe("hookRateLimit — a dashboard caller's bucket is per caller AND per session", () => {
	const { Hono } = require("hono") as typeof import("hono");

	function appFor() {
		const app = new Hono();
		app.use("*", async (c, next) => {
			const who = c.req.header("X-Test-User") ?? "nobody";
			c.set("authUser" as never, { id: who, userId: who, source: "local" } as never);
			await next();
		});
		app.post(
			"/sessions/:sessionId/acknowledge",
			hookRateLimit({ bucketPrefix: "ack-test:", onLimit: "429" }),
			(c) => c.json({ ok: true }),
		);
		return app;
	}

	test("one user exhausting a session's bucket doesn't throttle another user on the same session, or themselves on another session", async () => {
		_setRateLimitClockForTest(() => 7_000_000);
		const app = appFor();
		const hit = (user: string, session: string) =>
			app.request(`/sessions/${session}/acknowledge`, {
				method: "POST",
				headers: { "X-Test-User": user },
			});

		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++)
			expect((await hit("user-a", "s1")).status).toBe(200);
		expect((await hit("user-a", "s1")).status).toBe(429);

		expect((await hit("user-b", "s1")).status).toBe(200);
		expect((await hit("user-a", "s2")).status).toBe(200);
		_setRateLimitClockForTest(null);
	});
});

describe("the bucket table doesn't grow without bound", () => {
	afterEach(() => _setBucketCapForTest(null));

	test("idle buckets (they would have refilled in full) are dropped on a schedule", () => {
		let nowMs = 1_000_000;
		const now = () => nowMs;
		for (const key of ["idle-1", "idle-2", "idle-3"]) tryConsume(key, now);
		expect(_trackedBucketsForTest()).toBe(3);

		nowMs += 11_000;
		tryConsume("fresh", now);

		expect(_trackedBucketsForTest()).toBe(1);
	});

	test("a drained bucket is not dropped before it would have refilled", () => {
		let nowMs = 2_000_000;
		const now = () => nowMs;
		tryConsume("warm-up", now);
		nowMs += 4_800;
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) tryConsume("busy", now);
		expect(tryConsume("busy", now)).toBe(false);

		// The sweep runs now, but "busy" was last used 200 ms ago: it has only
		// refilled for those 200 ms, so a dropped (fresh, full) bucket would let
		// the whole capacity through again.
		nowMs += 200;
		tryConsume("other", now);
		let allowed = 0;
		for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) if (tryConsume("busy", now)) allowed++;
		expect(allowed).toBe(Math.floor(RATE_LIMIT_CAPACITY * 0.2));
	});

	test("the table is capped: the oldest entries go first, and a new key still gets a bucket", () => {
		_setBucketCapForTest(5);
		const now = () => 3_000_000;
		for (let i = 0; i < 8; i++) tryConsume(`cap-${i}`, now);
		expect(_trackedBucketsForTest()).toBeGreaterThan(0);
		expect(_trackedBucketsForTest()).toBeLessThanOrEqual(5);
		expect(tryConsume("cap-8", now)).toBe(true);
	});
});
