import { describe, expect, test } from "bun:test";
import { createRequestOrder } from "./request-order.js";

describe("createRequestOrder", () => {
	test("in order: both claim, newer last", () => {
		const order = createRequestOrder();
		const a = order.begin();
		expect(a.claim()).toBe(true);
		const b = order.begin();
		expect(b.claim()).toBe(true);
	});

	test("out of order: an older answer after a newer one is refused", () => {
		const order = createRequestOrder();
		const a = order.begin();
		const b = order.begin();
		expect(b.claim()).toBe(true);
		expect(a.claim()).toBe(false);
		expect(a.peek()).toBe(false);
	});

	test("oldest-first resolution never starves: three overlapping requests all claim", () => {
		const order = createRequestOrder();
		const [a, b, c] = [order.begin(), order.begin(), order.begin()];
		expect([a.claim(), b.claim(), c.claim()]).toEqual([true, true, true]);
	});

	test("peek records nothing: a newer failure doesn't block an older success", () => {
		const order = createRequestOrder();
		const a = order.begin();
		const b = order.begin();
		expect(b.peek()).toBe(true);
		expect(a.claim()).toBe(true);
	});

	test("an older failure after a newer claimed success is not reportable", () => {
		const order = createRequestOrder();
		const a = order.begin();
		const b = order.begin();
		expect(b.claim()).toBe(true);
		expect(a.peek()).toBe(false);
	});

	test("the same ticket may claim again", () => {
		const order = createRequestOrder();
		const a = order.begin();
		expect(a.claim()).toBe(true);
		expect(a.claim()).toBe(true);
	});

	test("markApplied refuses tickets begun before it and leaves later ones alone", () => {
		const order = createRequestOrder();
		const before = order.begin();
		order.markApplied();
		const after = order.begin();
		expect(before.claim()).toBe(false);
		expect(before.peek()).toBe(false);
		expect(after.claim()).toBe(true);
	});
});
