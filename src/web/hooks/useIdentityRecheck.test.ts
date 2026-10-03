import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { _resetIdentityRecheckForTest, useUserStore } from "../stores/user-store.js";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useIdentityRecheck } from "./useIdentityRecheck.js";

/** A tab that comes back to the front asks who the viewer is again, once, and only while the app is in use. */
const realFetch = globalThis.fetch;
let meCalls = 0;
let visibility: (() => void) | null = null;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(() => {
	meCalls = 0;
	visibility = null;
	_resetIdentityRecheckForTest();
	useUserStore.setState({ authenticated: false, userId: null } as never);
	const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
	doc.hidden = false;
	doc.addEventListener = (type: string, handler: () => void) => {
		if (type === "visibilitychange") visibility = handler;
	};
	doc.removeEventListener = (type: string) => {
		if (type === "visibilitychange") visibility = null;
	};
	globalThis.fetch = (() => {
		meCalls += 1;
		return Promise.resolve(
			new Response(
				JSON.stringify({
					authenticated: true,
					user: null,
					signOutUrl: null,
					disableAuth: true,
					allowSignup: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	useUserStore.setState({ authenticated: false, userId: null, disableAuth: false } as never);
});

async function becomeVisible() {
	await act(async () => {
		visibility?.();
	});
	await new Promise((r) => setTimeout(r, 20));
}

describe("a tab coming back to the front", () => {
	test("re-asks who the viewer is, once however many times it flips", async () => {
		const h = renderHook((enabled: boolean) => useIdentityRecheck(enabled), true);
		await h.render(true);
		await becomeVisible();
		await becomeVisible();
		expect(meCalls).toBe(1);
		await h.unmount();
	});

	test("does nothing while the tab is going to the back", async () => {
		const h = renderHook((enabled: boolean) => useIdentityRecheck(enabled), true);
		await h.render(true);
		(globalThis as unknown as { document: { hidden: boolean } }).document.hidden = true;
		await becomeVisible();
		expect(meCalls).toBe(0);
		await h.unmount();
	});

	test("does nothing before the viewer may use the app", async () => {
		const h = renderHook((enabled: boolean) => useIdentityRecheck(enabled), false);
		await h.render(false);
		await becomeVisible();
		expect(meCalls).toBe(0);
		await h.unmount();
	});
});
