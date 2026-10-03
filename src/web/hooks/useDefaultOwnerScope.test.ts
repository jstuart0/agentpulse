import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useUserStore } from "../stores/user-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useDefaultOwnerScope } from "./useDefaultOwnerScope.js";
import { resetOwnSessionCountForTest } from "./useOwnSessionCount.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const store = new Map<string, string>();

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(() => {
	store.clear();
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	};
	useDashboardScopeStore.setState({ owner: "all", resolved: false });
	useUserStore.setState({ userId: "viewer", mode: "team", effectiveRole: "member" } as never);
	resetOwnSessionCountForTest();
});

afterEach(() => {
	Object.assign(api, real);
	useUserStore.setState({ mode: "solo" } as never);
	useDashboardScopeStore.setState({ owner: "all", resolved: true });
});

describe("the scope the dashboard opens on", () => {
	test("a team viewer who owns sessions opens on Mine; one who owns none, on Everyone", async () => {
		client.getSessions = () => Promise.resolve({ sessions: [], total: 7 });
		const owns = renderHook(() => useDefaultOwnerScope(), null);
		await owns.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "me", resolved: true });
		await owns.unmount();

		useDashboardScopeStore.setState({ owner: "all", resolved: false });
		resetOwnSessionCountForTest();
		client.getSessions = () => Promise.resolve({ sessions: [], total: 0 });
		const none = renderHook(() => useDefaultOwnerScope(), null);
		await none.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "all", resolved: true });
		await none.unmount();
	});

	test("the question asks for the viewer's own sessions only, whatever the toggle", async () => {
		const seen: Array<{ owner?: string; excludeScratch?: boolean; limit?: number }> = [];
		client.getSessions = (query: { owner?: string; excludeScratch?: boolean; limit?: number }) => {
			seen.push({ owner: query.owner, excludeScratch: query.excludeScratch, limit: query.limit });
			return Promise.resolve({ sessions: [], total: 1 });
		};
		const h = renderHook(() => useDefaultOwnerScope(), null);
		await h.render(null);
		await flush();
		expect(seen).toEqual([{ owner: "me", excludeScratch: undefined, limit: 1 }]);
		await h.unmount();
	});

	test("a stored choice wins and asks nothing", async () => {
		store.set("agentpulse.dashboard.scope.viewer", "everyone");
		let asked = 0;
		client.getSessions = () => {
			asked += 1;
			return Promise.resolve({ sessions: [], total: 9 });
		};
		const h = renderHook(() => useDefaultOwnerScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "all", resolved: true });
		expect(asked).toBe(0);
		await h.unmount();
	});

	test("when the question can't be asked the dashboard opens on Everyone", async () => {
		client.getSessions = () => Promise.reject(new TypeError("Failed to fetch"));
		const h = renderHook(() => useDefaultOwnerScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "all", resolved: true });
		await h.unmount();
	});

	test("switching the instance back to solo puts a dashboard that was on Mine back on Everyone", async () => {
		store.set("agentpulse.dashboard.scope.viewer", "mine");
		client.getSessions = () => Promise.resolve({ sessions: [], total: 3 });
		const h = renderHook(() => useDefaultOwnerScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "me", resolved: true });

		await act(async () => {
			useUserStore.setState({ mode: "solo" } as never);
		});
		await flush();

		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "all", resolved: true });
		await h.unmount();
	});

	test("solo is Everyone from the start, with no question", async () => {
		useUserStore.setState({ mode: "solo" } as never);
		let asked = 0;
		client.getSessions = () => {
			asked += 1;
			return Promise.resolve({ sessions: [], total: 9 });
		};
		const h = renderHook(() => useDefaultOwnerScope(), null);
		await h.render(null);
		await flush();
		expect(useDashboardScopeStore.getState()).toMatchObject({ owner: "all", resolved: true });
		expect(asked).toBe(0);
		await h.unmount();
	});
});
