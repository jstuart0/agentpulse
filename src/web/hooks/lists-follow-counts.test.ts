import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useReachabilityStore } from "../stores/reachability-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useListFollowsCount } from "./useListFollowsCount.js";
import { useSessions } from "./useSessions.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const ME = "me-id";
const mine: DashboardScope = { owner: "me", excludeScratch: true };
const all: DashboardScope = { owner: "all", excludeScratch: true };

// biome-ignore lint/suspicious/noExplicitAny: a hand-built row stands in for the server's DTO
function sess(id: string, owner: string | null = ME): any {
	return {
		sessionId: id,
		ownerUserId: owner,
		ownerKind: owner ? "user" : "unassigned",
		status: "active",
		isWorking: true,
		isArchived: false,
		endedAt: null,
		isPinned: false,
		cwd: "/w",
		agentType: "claude_code",
	};
}

// biome-ignore lint/suspicious/noExplicitAny: a hand-built body stands in for the server's stats
function stats(n: number, extra: Record<string, unknown> = {}): any {
	return {
		activeSessions: n,
		totalSessionsToday: 0,
		totalToolUsesToday: 0,
		byAgentType: {},
		operational: { waiting: n, working: 0, idle: 0, error: 0 },
		truncated: false,
		completedCount: 0,
		archivedCount: 0,
		total: n,
		scratchHidden: 0,
		...extra,
	};
}

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

describe("a list follows the count that describes it", () => {
	type Props = Parameters<typeof useListFollowsCount>[0];
	function setup(first: Props) {
		let refreshes = 0;
		const h = renderHook((p: Props) => useListFollowsCount(p), first);
		const props = (over: Partial<Props>): Props => ({
			...first,
			refresh: () => {
				refreshes += 1;
			},
			...over,
		});
		return { h, props, refreshes: () => refreshes };
	}
	const base: Props = {
		listTotal: 4,
		settled: true,
		expected: 4,
		countsVersion: 1,
		refresh: () => {},
	};

	test("a count that differs from the loaded list's total refetches the list once", async () => {
		const t = setup(base);
		await t.h.render(t.props({ expected: 0, countsVersion: 2 }));
		await flush();
		expect(t.refreshes()).toBe(1);
		await t.h.unmount();
	});

	test("a count equal to the total refetches nothing", async () => {
		const t = setup(base);
		await t.h.render(t.props({ expected: 4, countsVersion: 2 }));
		await flush();
		expect(t.refreshes()).toBe(0);
		await t.h.unmount();
	});

	test("no count yet, or a list still loading, refetches nothing", async () => {
		const t = setup(base);
		await t.h.render(t.props({ expected: undefined, countsVersion: 2 }));
		await t.h.render(t.props({ expected: 0, settled: false, countsVersion: 3 }));
		await t.h.render(t.props({ expected: 0, listTotal: null, countsVersion: 4 }));
		await flush();
		expect(t.refreshes()).toBe(0);
		await t.h.unmount();
	});

	test("a list total that moves while the counts stay the same doesn't ask again", async () => {
		const t = setup(base);
		await t.h.render(t.props({ expected: 0, countsVersion: 2 }));
		await t.h.render(t.props({ expected: 0, listTotal: 3, countsVersion: 2 }));
		await t.h.render(t.props({ expected: 0, listTotal: 2, countsVersion: 2 }));
		await flush();
		expect(t.refreshes()).toBe(1);
		await t.h.unmount();
	});

	test("the same disagreement at the next poll asks once more, not in a loop", async () => {
		const t = setup(base);
		await t.h.render(t.props({ expected: 0, countsVersion: 2 }));
		await t.h.render(t.props({ expected: 0, countsVersion: 2 }));
		await flush();
		expect(t.refreshes()).toBe(1);
		await t.h.render(t.props({ expected: 0, countsVersion: 3 }));
		await flush();
		expect(t.refreshes()).toBe(2);
		await t.h.unmount();
	});
});

describe("useSessions resyncs", () => {
	const intervals: Array<() => void> = [];
	const realSetInterval = globalThis.setInterval;
	beforeEach(() => {
		intervals.length = 0;
		// biome-ignore lint/suspicious/noExplicitAny: capturing the poll timer
		(globalThis as any).setInterval = (cb: () => void) => intervals.push(cb);
		useUserStore.setState({ userId: ME, mode: "team" } as never);
		useSessionStore.setState({
			sessions: [],
			stats: null,
			totalSessions: 0,
			othersStats: null,
			listedKey: null,
			isLoading: true,
		});
		useConnectionStore.setState({ wsState: "reconnecting", lastConnectedAt: null });
		client.getEveryoneStats = () => Promise.resolve(stats(0));
	});
	afterEach(() => {
		globalThis.setInterval = realSetInterval;
		Object.assign(api, real);
	});

	test("when the socket comes back, the list, the counts and the caller's lists are refreshed", async () => {
		let asked = 0;
		client.getSessions = () => {
			asked += 1;
			return Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		client.getStats = () => Promise.resolve(stats(1));
		const reasons: string[] = [];
		const h = renderHook(
			(s: DashboardScope) => useSessions(s, (reason) => reasons.push(String(reason))),
			mine,
		);
		await h.render(mine);
		await flush();
		useConnectionStore.getState().markConnected();
		await flush();
		expect(asked).toBe(1);
		useConnectionStore.getState().setWsState("reconnecting");
		await flush();
		useConnectionStore.getState().markConnected();
		await flush();
		expect(asked).toBe(2);
		expect(reasons).toEqual(["reconnect"]);
		await h.unmount();
	});

	test("Retry re-asks and lets the caller reload its lists once the answer lands", async () => {
		client.getSessions = () => Promise.resolve({ sessions: [sess("m1")], total: 1 });
		client.getStats = () => Promise.resolve(stats(1));
		const reasons: string[] = [];
		const h = renderHook(
			(s: DashboardScope) => useSessions(s, (reason) => reasons.push(String(reason))),
			mine,
		);
		await h.render(mine);
		await flush();
		await h.current.value?.retry();
		await flush();
		expect(reasons).toEqual(["retry"]);
		await h.unmount();
	});

	test("a Retry whose answer fails doesn't make a later, unrelated answer look like a Retry", async () => {
		let fail = false;
		client.getSessions = () =>
			fail
				? Promise.reject(new Error("down"))
				: Promise.resolve({ sessions: [sess("m1")], total: 1 });
		client.getStats = () => Promise.resolve(stats(1));
		const reasons: string[] = [];
		const h = renderHook(
			(s: DashboardScope) => useSessions(s, (reason) => reasons.push(String(reason))),
			mine,
		);
		await h.render(mine);
		await flush();
		fail = true;
		await h.current.value?.retry();
		await flush();
		fail = false;
		await h.render(all);
		await flush();
		expect(reasons).toEqual([]);
		await h.unmount();
	});

	test("while the sign-in is unconfirmed, a recovery signal doesn't send the requests again (no request storm)", async () => {
		let asked = 0;
		client.getSessions = () => {
			asked += 1;
			return Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		client.getStats = () => Promise.resolve(stats(1));
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		expect(asked).toBe(1);
		useUserStore.setState({ sessionUnconfirmed: true } as never);
		await act(async () => {
			useReachabilityStore.setState({ unreachable: true });
			useReachabilityStore.getState().reportSuccess();
		});
		await flush();
		expect(asked).toBe(1);
		await act(async () => {
			useUserStore.setState({ sessionUnconfirmed: false } as never);
		});
		await flush();
		expect(asked).toBe(2);
		await h.unmount();
	});

	test("nothing from the previous view is returned on the render that changes it", async () => {
		client.getSessions = () => Promise.resolve({ sessions: [sess("a1", "alice")], total: 1 });
		client.getStats = () => Promise.resolve(stats(7));
		const seen: Array<{ owner: string; rows: number; loading: boolean; stats: boolean }> = [];
		const h = renderHook((s: DashboardScope) => {
			const r = useSessions(s);
			seen.push({
				owner: s.owner,
				rows: r.sessions.length,
				loading: r.isLoading,
				stats: r.stats !== null,
			});
			return r;
		}, all);
		await h.render(all);
		await flush();
		seen.length = 0;
		await h.render(mine);
		const firstMine = seen.find((entry) => entry.owner === "me");
		expect(firstMine).toEqual({ owner: "me", rows: 0, loading: true, stats: false });
		await h.unmount();
	});

	test("a failed first answer is an error with Retry, not an empty list", async () => {
		client.getSessions = () => Promise.reject(new Error("down"));
		client.getStats = () => Promise.resolve(stats(0));
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		expect(h.current.value?.loadError).toBe("down");
		expect(h.current.value?.isLoading).toBe(false);
		await h.unmount();
	});
});
