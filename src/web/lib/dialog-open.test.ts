import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { registerOpenDialog, useAnyDialogOpen, useToastPosition } from "./dialog-open.js";

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

describe("open dialogs are counted", () => {
	test("any dialog open is true until the last one closes; closing twice changes nothing", async () => {
		const h = renderHook(() => useAnyDialogOpen(), null);
		await h.render(null);
		expect(h.current.value).toBe(false);
		let closeFirst = () => {};
		let closeSecond = () => {};
		await act(async () => {
			closeFirst = registerOpenDialog();
			closeSecond = registerOpenDialog();
		});
		expect(h.current.value).toBe(true);
		await act(async () => {
			closeFirst();
			closeFirst();
		});
		expect(h.current.value).toBe(true);
		await act(async () => {
			closeSecond();
		});
		expect(h.current.value).toBe(false);
		await h.unmount();
	});
});

describe("useToastPosition", () => {
	test("opening a dialog on a phone moves toasts to the top without breaking the component (hook order is stable)", async () => {
		const g = globalThis as unknown as { matchMedia?: unknown };
		const had = g.matchMedia;
		g.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
		const h = renderHook(() => useToastPosition(), null);
		await h.render(null);
		expect(h.current.value).toBe("bottom-right");
		let close = () => {};
		await act(async () => {
			close = registerOpenDialog();
		});
		expect(h.current.value).toBe("top-center");
		await act(async () => close());
		expect(h.current.value).toBe("bottom-right");
		await h.unmount();
		g.matchMedia = had;
	});
});
