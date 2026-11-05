/**
 * The arming behind ConfirmDialog's `armAfterMs`: a tap on Confirm in the first moments after a dialog opens
 * does nothing. It is a hook so it can be driven here without a DOM; ConfirmDialog disables its button on
 * `!armed`, and the take-over dialog's source test cites this file for the behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useArmedAfter } from "./useArmedAfter.js";

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

describe("useArmedAfter", () => {
	test("with no delay it is armed from the first render", async () => {
		const h = renderHook(useArmedAfter, 0);
		await h.render(0);
		expect(h.current.value).toBe(true);
		await h.unmount();
	});

	test("with a delay it starts unarmed, stays unarmed before the time, and arms after it", async () => {
		const h = renderHook(useArmedAfter, 60);
		await h.render(60);
		expect(h.current.value).toBe(false);
		await flush(20);
		expect(h.current.value).toBe(false);
		await flush(80);
		expect(h.current.value).toBe(true);
		await h.unmount();
	});

	test("a remount starts unarmed again: a re-opened dialog re-arms", async () => {
		const first = renderHook(useArmedAfter, 40);
		await first.render(40);
		await flush(80);
		expect(first.current.value).toBe(true);
		await first.unmount();
		const second = renderHook(useArmedAfter, 40);
		await second.render(40);
		expect(second.current.value).toBe(false);
		await second.unmount();
	});

	test("unmounting before the time leaves no timer to arm anything later", async () => {
		const h = renderHook(useArmedAfter, 30);
		await h.render(30);
		await h.unmount();
		await flush(60);
		expect(h.current.value).toBe(false);
	});
});
