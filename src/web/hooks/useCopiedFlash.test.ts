/** AGEN-69 review fix U-1: the pressed copy button says "Copied" for a moment, then goes back. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { COPIED_FLASH_MS, useCopiedFlash } from "./useCopiedFlash.js";

beforeEach(() => installDomStubs());
afterEach(() => removeDomStubs());

describe("useCopiedFlash", () => {
	test("the flash is two seconds by default", () => {
		expect(COPIED_FLASH_MS).toBe(2000);
	});

	test("it names the pressed button, then reverts after the delay", async () => {
		const probe = renderHook(() => useCopiedFlash(40), undefined);
		await probe.render(undefined);
		expect(probe.current.value?.[0]).toBeNull();
		await import("react").then(({ act }) => act(async () => probe.current.value?.[1]("summary")));
		expect(probe.current.value?.[0]).toBe("summary");
		await flush(90);
		expect(probe.current.value?.[0]).toBeNull();
		await probe.unmount();
	});

	test("a second press restarts the flash on the new button", async () => {
		const probe = renderHook(() => useCopiedFlash(60), undefined);
		await probe.render(undefined);
		const { act } = await import("react");
		await act(async () => probe.current.value?.[1]("handoff"));
		await flush(35);
		await act(async () => probe.current.value?.[1]("context"));
		await flush(35);
		expect(probe.current.value?.[0]).toBe("context");
		await flush(60);
		expect(probe.current.value?.[0]).toBeNull();
		await probe.unmount();
	});
});
