import { describe, expect, test } from "bun:test";
import { TtlCache } from "./ttl-cache.js";

// All tests use an injected `nowFn` to advance time deterministically rather
// than racing a real clock or stubbing `Date.now`.
function makeClock(initial = 0) {
	let t = initial;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		set: (next: number) => {
			t = next;
		},
	};
}

describe("TtlCache", () => {
	test("getOrLoad calls loader once within TTL window", async () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return 42;
		};

		expect(await cache.getOrLoad("k", loader)).toBe(42);
		expect(await cache.getOrLoad("k", loader)).toBe(42);
		expect(await cache.getOrLoad("k", loader)).toBe(42);
		expect(calls).toBe(1);
	});

	test("getOrLoad re-invokes loader once entry has expired", async () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return calls;
		};

		expect(await cache.getOrLoad("k", loader)).toBe(1);
		clock.advance(50);
		expect(await cache.getOrLoad("k", loader)).toBe(1);
		clock.advance(60); // total 110ms — past 100ms TTL
		expect(await cache.getOrLoad("k", loader)).toBe(2);
		expect(calls).toBe(2);
	});

	test("invalidate(key) drops one entry; subsequent get hits loader", async () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return calls;
		};

		await cache.getOrLoad("a", loader);
		await cache.getOrLoad("b", loader);
		cache.invalidate("a");

		await cache.getOrLoad("a", loader); // miss → loader runs
		await cache.getOrLoad("b", loader); // still fresh → no loader
		expect(calls).toBe(3);
	});

	test("invalidate() with no arg clears every entry", async () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return calls;
		};

		await cache.getOrLoad("a", loader);
		await cache.getOrLoad("b", loader);
		cache.invalidate();

		await cache.getOrLoad("a", loader);
		await cache.getOrLoad("b", loader);
		expect(calls).toBe(4);
	});

	test("setNow seeds a value that getOrLoad will return without calling loader", async () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			return -1;
		};

		cache.setNow("k", 99);
		expect(await cache.getOrLoad("k", loader)).toBe(99);
		expect(calls).toBe(0);
	});

	test("hasFresh reports correctly across the expiry boundary", () => {
		const clock = makeClock(1000);
		const cache = new TtlCache<string, number>(100, clock.now);
		cache.setNow("k", 5);
		expect(cache.hasFresh("k")).toBe(true);
		clock.advance(101);
		expect(cache.hasFresh("k")).toBe(false);
		expect(cache.hasFresh("missing")).toBe(false);
	});

	test("constructor rejects non-positive TTL", () => {
		expect(() => new TtlCache<string, number>(0)).toThrow();
		expect(() => new TtlCache<string, number>(-1)).toThrow();
		expect(() => new TtlCache<string, number>(Number.NaN)).toThrow();
	});
});
