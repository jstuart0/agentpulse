import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { HOST_UNKNOWN, hostStorageKey } from "../lib/host-scope.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useUserStore } from "../stores/user-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useHostScope } from "./useHostScope.js";

const store = new Map<string, string>();
let refuseWrites = false;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(() => {
	store.clear();
	refuseWrites = false;
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			if (refuseWrites) throw new Error("quota");
			store.set(key, value);
		},
	};
	useDashboardScopeStore.setState({ host: "", hostResolved: false });
	useUserStore.setState({ userId: "viewer", mode: "solo" } as never);
});

afterEach(() => {
	useDashboardScopeStore.setState({ host: "", hostResolved: true });
});

describe("the machine the dashboard opens on", () => {
	test("every machine when nothing is stored, and the scope is then settled", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ host: "", hostResolved: true });
		expect(h.current.value?.host).toBe("");
		await h.unmount();
	});

	test("a stored machine is applied before anything is asked, in solo as in a team", async () => {
		store.set(hostStorageKey("viewer"), "build-01");
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({
			host: "build-01",
			hostResolved: true,
		});
		await h.unmount();
	});

	test("a stored unknown is applied", async () => {
		store.set(hostStorageKey("viewer"), HOST_UNKNOWN);
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState().host).toBe(HOST_UNKNOWN);
		await h.unmount();
	});

	test("a stored value outside the grammar can't hide the list, and the hook says it was dropped", async () => {
		store.set(hostStorageKey("viewer"), "bad\nvalue");
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ host: "", hostResolved: true });
		expect(h.current.value?.storedChoiceDropped).toBe(true);
		await h.unmount();
	});

	test("nothing stored, or a good value, drops nothing", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(h.current.value?.storedChoiceDropped).toBe(false);
		await h.unmount();
	});

	test("another person's stored choice is not this person's", async () => {
		store.set(hostStorageKey("someone-else"), "edge-02");
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState().host).toBe("");
		await h.unmount();
	});
});

describe("choosing a machine", () => {
	test("applies it at once and remembers it for next time", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		await act(async () => h.current.value?.choose("edge-02"));
		expect(useDashboardScopeStore.getState().host).toBe("edge-02");
		expect(store.get(hostStorageKey("viewer"))).toBe("edge-02");
		await act(async () => h.current.value?.choose(""));
		expect(useDashboardScopeStore.getState().host).toBe("");
		expect(store.get(hostStorageKey("viewer"))).toBe("");
		await h.unmount();
	});

	test("a name is stored trimmed", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		await act(async () => void h.current.value?.choose("  build-01 "));
		expect(useDashboardScopeStore.getState().host).toBe("build-01");
		expect(store.get(hostStorageKey("viewer"))).toBe("build-01");
		await h.unmount();
	});

	test("a choice the filter can't express is refused and reported, and the view is left as it was, never widened to every machine", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		await act(async () => void h.current.value?.choose("edge-02"));
		let accepted = true;
		await act(async () => {
			accepted = h.current.value?.choose("a\nb") ?? true;
		});
		expect(accepted).toBe(false);
		expect(useDashboardScopeStore.getState().host).toBe("edge-02");
		expect(store.get(hostStorageKey("viewer"))).toBe("edge-02");
		await act(async () => {
			accepted = h.current.value?.choose("x".repeat(300)) ?? true;
		});
		expect(accepted).toBe(false);
		expect(useDashboardScopeStore.getState().host).toBe("edge-02");
		await h.unmount();
	});

	test("storage that refuses the write still holds the choice for this visit", async () => {
		const h = renderHook(() => useHostScope(), null);
		await h.render(null);
		await flush();
		refuseWrites = true;
		await act(async () => h.current.value?.choose("edge-02"));
		expect(useDashboardScopeStore.getState().host).toBe("edge-02");
		await h.unmount();
	});
});
