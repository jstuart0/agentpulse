/**
 * The global limit on concurrent Ask turns: `config.askMaxConcurrent` holders,
 * at most 4 waiters in first-in first-out order, each waiting at most 30 s and
 * leaving the queue early if its caller goes away. Time goes through the
 * limiter's timer seam, so nothing here sleeps.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { createFakeClock } from "../../test-utils/fake-clock.js";
import type { FakeClock } from "../../test-utils/fake-clock.js";

const limiter = await import("./ask-turn-limiter.js");

const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;
const WAIT_MS = 30_000;

let clock: FakeClock;

beforeEach(() => {
	limiter.__resetAskTurnLimiterForTests();
	clock = createFakeClock();
	limiter.__setAskLimiterClockForTests({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	cfg.askMaxConcurrent = 2;
});

afterEach(() => {
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
});

/** What a pending acquisition has turned into so far, without awaiting it. */
function track(promise: Promise<unknown>) {
	const state: { status: "pending" | "granted" | "refused"; error?: unknown; slot?: unknown } = {
		status: "pending",
	};
	promise.then(
		(slot) => {
			state.status = "granted";
			state.slot = slot;
		},
		(error) => {
			state.status = "refused";
			state.error = error;
		},
	);
	return state;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("capacity", () => {
	test("2 run at once, 4 more wait, and the 7th is refused at once without any timer firing", async () => {
		const acquisitions = Array.from({ length: 6 }, () => track(limiter.acquireAskTurn()));
		await settle();
		expect(acquisitions.map((a) => a.status)).toEqual([
			"granted",
			"granted",
			"pending",
			"pending",
			"pending",
			"pending",
		]);
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 2, waiting: 4 });

		const seventh = limiter.acquireAskTurn();
		await expect(seventh).rejects.toBeInstanceOf(limiter.AskBusyError);
		expect(clock.pendingTimers()).toBe(4);
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 2, waiting: 4, rejected: 1 });
	});

	test("the limit is read from config on every call", async () => {
		cfg.askMaxConcurrent = 1;
		const first = await limiter.acquireAskTurn();
		const second = track(limiter.acquireAskTurn());
		await settle();
		expect(second.status).toBe("pending");

		cfg.askMaxConcurrent = 8;
		first.release();
		await settle();
		expect(second.status).toBe("granted");
		for (let i = 0; i < 7; i++) await limiter.acquireAskTurn();
		expect(limiter.getAskTurnLimiterStats().running).toBe(8);
	});
});

describe("order, timeout and abort", () => {
	test("waiters are admitted oldest first as turns settle", async () => {
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const order: number[] = [];
		const waiters = [0, 1, 2, 3].map((i) =>
			limiter.acquireAskTurn().then((slot) => {
				order.push(i);
				return slot;
			}),
		);
		await settle();

		held[0]?.release();
		await settle();
		expect(order).toEqual([0]);
		held[1]?.release();
		await settle();
		expect(order).toEqual([0, 1]);
		(await waiters[0])?.release();
		await settle();
		(await waiters[1])?.release();
		await settle();
		expect(order).toEqual([0, 1, 2, 3]);
	});

	test("a waiter is refused 30,000 ms after it joined, not before, and the next waiter then gets the next slot", async () => {
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const first = track(limiter.acquireAskTurn());
		clock.advance(10_000);
		const second = track(limiter.acquireAskTurn());
		await settle();

		clock.advance(WAIT_MS - 10_000 - 1);
		await settle();
		expect(first.status).toBe("pending");

		clock.advance(1);
		await settle();
		expect(first.status).toBe("refused");
		expect(first.error).toBeInstanceOf(limiter.AskBusyError);
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ waiting: 1, rejected: 1 });

		held[0]?.release();
		await settle();
		expect(second.status).toBe("granted");
	});

	test("a granted slot's timer is cleared, so nothing fires later", async () => {
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const waiter = track(limiter.acquireAskTurn());
		await settle();
		held[0]?.release();
		await settle();
		expect(waiter.status).toBe("granted");
		expect(clock.pendingTimers()).toBe(0);
	});

	test("a waiter whose signal aborts leaves the queue, is counted, and the next in line is admitted in order", async () => {
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const controller = new AbortController();
		const aborted = track(limiter.acquireAskTurn({ signal: controller.signal }));
		const next = track(limiter.acquireAskTurn());
		await settle();

		controller.abort();
		await settle();
		expect(aborted.status).toBe("refused");
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ waiting: 1, aborted: 1 });
		expect(clock.pendingTimers()).toBe(1);

		held[0]?.release();
		await settle();
		expect(next.status).toBe("granted");
		expect(aborted.status).toBe("refused");
	});

	test("an already-aborted signal never joins the queue", async () => {
		await limiter.acquireAskTurn();
		await limiter.acquireAskTurn();
		const controller = new AbortController();
		controller.abort();
		await expect(limiter.acquireAskTurn({ signal: controller.signal })).rejects.toBeDefined();
		expect(limiter.getAskTurnLimiterStats().waiting).toBe(0);
	});

	test("aborting the signal of a turn that already holds its slot changes nothing", async () => {
		const controller = new AbortController();
		const slot = await limiter.acquireAskTurn({ signal: controller.signal });
		controller.abort();
		await settle();
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 1, aborted: 0 });
		slot.release();
		expect(limiter.getAskTurnLimiterStats().running).toBe(0);
	});

	test("a waiter admitted while its signal is later aborted keeps its slot", async () => {
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const controller = new AbortController();
		const waiter = track(limiter.acquireAskTurn({ signal: controller.signal }));
		await settle();
		held[0]?.release();
		await settle();
		expect(waiter.status).toBe("granted");
		controller.abort();
		await settle();
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 2, aborted: 0 });
	});
});

describe("tryAcquireAskTurn", () => {
	test("returns a slot while there is room and null at capacity, and never queues", async () => {
		const a = limiter.tryAcquireAskTurn();
		const b = limiter.tryAcquireAskTurn();
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(limiter.tryAcquireAskTurn()).toBeNull();
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 2, waiting: 0 });
		expect(clock.pendingTimers()).toBe(0);

		a?.release();
		expect(limiter.tryAcquireAskTurn()).not.toBeNull();
	});

	test("does not jump a queue that has waiters", async () => {
		cfg.askMaxConcurrent = 1;
		const held = await limiter.acquireAskTurn();
		const waiter = track(limiter.acquireAskTurn());
		await settle();
		held.release();
		// the freed slot went to the waiter, so there is nothing left to take
		expect(limiter.tryAcquireAskTurn()).toBeNull();
		await settle();
		expect(waiter.status).toBe("granted");
	});
});

describe("slots", () => {
	test("release is idempotent: releasing twice frees one place", async () => {
		const a = await limiter.acquireAskTurn();
		await limiter.acquireAskTurn();
		const queued = track(limiter.acquireAskTurn());
		await settle();

		a.release();
		a.release();
		await settle();
		expect(limiter.getAskTurnLimiterStats()).toMatchObject({ running: 2, waiting: 0 });
		expect(queued.status).toBe("granted");
		const extra = track(limiter.acquireAskTurn());
		await settle();
		expect(extra.status).toBe("pending");
	});

	test("one slot's release cannot free another's place", async () => {
		const a = await limiter.acquireAskTurn();
		const b = await limiter.acquireAskTurn();
		a.release();
		a.release();
		expect(limiter.getAskTurnLimiterStats().running).toBe(1);
		b.release();
		expect(limiter.getAskTurnLimiterStats().running).toBe(0);
	});

	test("the counters follow every transition", async () => {
		expect(limiter.getAskTurnLimiterStats()).toEqual({
			running: 0,
			waiting: 0,
			rejected: 0,
			aborted: 0,
		});
		const held = [await limiter.acquireAskTurn(), await limiter.acquireAskTurn()];
		const controller = new AbortController();
		track(limiter.acquireAskTurn({ signal: controller.signal }));
		const timed = track(limiter.acquireAskTurn());
		await settle();
		expect(limiter.getAskTurnLimiterStats()).toEqual({
			running: 2,
			waiting: 2,
			rejected: 0,
			aborted: 0,
		});
		controller.abort();
		await settle();
		expect(limiter.getAskTurnLimiterStats()).toEqual({
			running: 2,
			waiting: 1,
			rejected: 0,
			aborted: 1,
		});
		clock.advance(WAIT_MS);
		await settle();
		expect(timed.status).toBe("refused");
		expect(limiter.getAskTurnLimiterStats()).toEqual({
			running: 2,
			waiting: 0,
			rejected: 1,
			aborted: 1,
		});
		held[0]?.release();
		held[1]?.release();
		expect(limiter.getAskTurnLimiterStats().running).toBe(0);
	});
});
