import { describe, expect, test } from "bun:test";
import { FixedWindowCounter } from "./fixed-window-counter.js";

describe("tryReserve and refund", () => {
	function counter() {
		let now = 1000;
		const c = new FixedWindowCounter(10_000);
		c.setClock(() => now);
		return {
			c,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	test("a reservation counts like a consume, and null says the subject is at its limit", () => {
		const { c } = counter();
		expect(c.tryReserve("a", 2)).not.toBeNull();
		expect(c.tryReserve("a", 2)).not.toBeNull();
		expect(c.tryReserve("a", 2)).toBeNull();
		expect(c.isAtLimit("a", 2)).toBe(true);
	});

	test("a refund gives the slot back", () => {
		const { c } = counter();
		const first = c.tryReserve("a", 1) as number;
		expect(c.tryReserve("a", 1)).toBeNull();
		c.refund("a", first);
		expect(c.tryReserve("a", 1)).not.toBeNull();
	});

	test("a refund for a window that has ended touches nothing in the new one", () => {
		const { c, advance } = counter();
		const old = c.tryReserve("a", 2) as number;
		advance(10_001);
		c.tryReserve("a", 2);
		c.tryReserve("a", 2);
		c.refund("a", old);
		expect(c.isAtLimit("a", 2)).toBe(true);
	});

	test("refunding more than was reserved never goes below zero", () => {
		const { c } = counter();
		const w = c.tryReserve("a", 3) as number;
		c.refund("a", w);
		c.refund("a", w);
		c.refund("a", w);
		expect(c.isAtLimit("a", 1)).toBe(false);
		expect(c.tryReserve("a", 1)).not.toBeNull();
		expect(c.tryReserve("a", 1)).toBeNull();
	});
});
