import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ApiError, api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";
import {
	TIMER_MARGIN_MS,
	deferred,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { MARK_ALL_SETTLE_MS, useAllWaitingSessions } from "./useAllWaitingSessions.js";
import { useOperationalSessionList } from "./useOperationalSessionList.js";
import { fetchOwnSessionCount, resetOwnSessionCountForTest } from "./useOwnSessionCount.js";
import { useOwnerGroupStats } from "./useOwnerGroupStats.js";
import { REFRESH_DEBOUNCE_MS } from "./useScopedPagedList.js";
import { useSessions } from "./useSessions.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const ME = "me-id";
const ALICE = "alice-id";
const all: DashboardScope = { owner: "all", excludeScratch: true };
const mine: DashboardScope = { owner: "me", excludeScratch: true };

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

// biome-ignore lint/suspicious/noExplicitAny: a hand-built group stands in for the server's
function group(owner: string): any {
	return {
		ownerUserId: owner,
		ownerKind: "user",
		total: 1,
		active: 1,
		idle: 0,
		completed: 0,
		working: 0,
		waiting: 1,
		error: 0,
	};
}

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => {
	useUserStore.setState({ userId: ME, mode: "team" } as never);
	useSessionStore.setState({
		sessions: [],
		stats: null,
		totalSessions: 0,
		othersStats: null,
		listedKey: null,
		isLoading: true,
	});
	resetOwnSessionCountForTest();
	client.getEveryoneStats = () => Promise.resolve(stats(0));
});
afterEach(() => Object.assign(api, real));

describe("an old request that fails late never wipes the live view", () => {
	test("paged list: switch away and back, the first request then rejects", async () => {
		const first = deferred<unknown>();
		let call = 0;
		client.getSessions = (q: { owner?: string }) => {
			call++;
			if (call === 1) return first.promise;
			return Promise.resolve({
				sessions: [sess(q.owner === "me" ? "m1" : "a1", q.owner === "me" ? ME : ALICE)],
				total: 1,
			});
		};
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			all,
		);
		await h.render(all);
		await h.render(mine);
		await h.render(all);
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["a1"]);
		first.reject(new Error("boom"));
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["a1"]);
		expect(h.current.value?.error).toBeNull();
		expect(h.current.value?.loading).toBe(false);
		await h.unmount();
	});

	test("paged list: a rejected first page under an old scope doesn't touch the new scope's loading state", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		client.getSessions = (q: { owner?: string }) =>
			q.owner === "me" ? second.promise : first.promise;
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			all,
		);
		await h.render(all);
		await h.render(mine);
		first.reject(new Error("old scope failed"));
		await flush();
		expect(h.current.value?.error).toBeNull();
		expect(h.current.value?.loading).toBe(true);
		second.resolve({ sessions: [sess("m1")], total: 1 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["m1"]);
		await h.unmount();
	});

	test("group stats: a late answer for the old scope is dropped, and a late failure changes nothing", async () => {
		const old = deferred<unknown>();
		client.getStatsByOwner = (q: { owner?: string }) =>
			q.owner === "me"
				? Promise.resolve({ groups: [group(ME)], ownerScope: { kind: "user", userId: ME } })
				: old.promise;
		const h = renderHook((s: DashboardScope) => useOwnerGroupStats(s, true), all);
		await h.render(all);
		await h.render(mine);
		await flush();
		old.resolve({ groups: [group(ALICE)] });
		await flush();
		expect([...(h.current.value?.groups?.keys() ?? [])]).toEqual([ME]);
		await h.unmount();
	});

	test("session list: an old poll that rejects after a switch and back leaves the new rows", async () => {
		const first = deferred<unknown>();
		let call = 0;
		client.getSessions = () => {
			call++;
			return call === 1 ? first.promise : Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		client.getStats = () => Promise.resolve(stats(1));
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await h.render(all);
		await h.render(mine);
		await flush();
		first.reject(new Error("boom"));
		await flush();
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["m1"]);
		expect(h.current.value?.isLoading).toBe(false);
		await h.unmount();
	});
});

describe("scoped queries cannot be forged", () => {
	const realFetch = globalThis.fetch;
	let sent = 0;
	beforeEach(() => {
		sent = 0;
		globalThis.fetch = (() => {
			sent += 1;
			return Promise.resolve(
				new Response(JSON.stringify({ sessions: [], total: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a query made by scopedQuery() is sent", async () => {
		await api.getSessions(scopedQuery(mine, { limit: 5 }));
		await api.getStats(scopedQuery(mine));
		await api.getStatsByOwner(scopedQuery(mine));
		expect(sent).toBe(3);
	});

	test("a spread copy of a real query is refused and nothing is sent", async () => {
		const live = scopedQuery(mine, { limit: 5 });
		const forged = { ...live, owner: "all" } as never;
		await expect(Promise.resolve().then(() => api.getSessions(forged))).rejects.toThrow();
		await expect(Promise.resolve().then(() => api.getStats(forged))).rejects.toThrow();
		await expect(Promise.resolve().then(() => api.getStatsByOwner(forged))).rejects.toThrow();
		expect(sent).toBe(0);
	});

	test("a hand-built object is refused too", async () => {
		await expect(
			Promise.resolve().then(() => api.getSessions({ owner: "all", limit: 1 } as never)),
		).rejects.toThrow();
		expect(sent).toBe(0);
	});
});

describe("answers are checked for the scope they describe", () => {
	test("mark-all paging: an answer that echoes a different scope leaves no targets", async () => {
		client.getSessions = () =>
			Promise.resolve({
				sessions: [sess("theirs", ALICE)],
				total: 1,
				ownerScope: { kind: "user", userId: ALICE },
			});
		const h = renderHook((s: DashboardScope) => useAllWaitingSessions(s, 1), mine);
		await h.render(mine);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		expect(h.current.value).toEqual([]);
		await h.unmount();
	});

	test("the default-scope probe: an answer that echoes another scope is treated as unknown", async () => {
		client.getSessions = () =>
			Promise.resolve({ sessions: [], total: 40, ownerScope: { kind: "user", userId: ALICE } });
		expect(await fetchOwnSessionCount()).toBeNull();
	});

	test("the default-scope probe: a matching echo gives the count", async () => {
		client.getSessions = () =>
			Promise.resolve({ sessions: [], total: 4, ownerScope: { kind: "user", userId: ME } });
		expect(await fetchOwnSessionCount()).toBe(4);
	});
});

describe("a server that says busy is asked again, not reported", () => {
	const realSetTimeout = globalThis.setTimeout;
	let timers: Array<{ cb: () => void; ms: number }> = [];
	beforeEach(() => {
		timers = [];
		// biome-ignore lint/suspicious/noExplicitAny: recording the delays asked for
		(globalThis as any).setTimeout = (cb: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms !== undefined && ms >= 1000 && ms !== 1100) {
				timers.push({ cb, ms });
				return 0;
			}
			return realSetTimeout(cb, ms, ...rest);
		};
	});
	afterEach(() => {
		globalThis.setTimeout = realSetTimeout;
	});
	const busy = (seconds: number | null) => new ApiError(503, "busy", { error: "busy" }, seconds);

	test("a busy first page keeps the list loading, waits the stated time, then lands", async () => {
		let call = 0;
		client.getSessions = () => {
			call++;
			return call === 1
				? Promise.reject(busy(2))
				: Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			mine,
		);
		await h.render(mine);
		await flush();
		expect(h.current.value?.error).toBeNull();
		expect(h.current.value?.loading).toBe(true);
		expect(timers.map((t) => t.ms)).toContain(2000);
		timers[0].cb();
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["m1"]);
		await h.unmount();
	});

	test("three busy answers in a row finally show the error", async () => {
		client.getSessions = () => Promise.reject(busy(1));
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			mine,
		);
		await h.render(mine);
		await flush();
		for (let i = 0; i < 2; i++) {
			expect(h.current.value?.error).toBeNull();
			timers.shift()?.cb();
			await flush();
		}
		expect(h.current.value?.error).not.toBeNull();
		await h.unmount();
	});

	test("session list: a busy poll keeps what is on screen and shows no error", async () => {
		let call = 0;
		client.getSessions = () => {
			call++;
			return call === 1
				? Promise.resolve({ sessions: [sess("m1")], total: 1 })
				: Promise.reject(busy(1));
		};
		client.getStats = () => Promise.resolve(stats(1));
		const intervals: Array<() => void> = [];
		const realSetInterval = globalThis.setInterval;
		// biome-ignore lint/suspicious/noExplicitAny: capturing the poll timer
		(globalThis as any).setInterval = (cb: () => void) => intervals.push(cb);
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		intervals[0]();
		await flush();
		globalThis.setInterval = realSetInterval;
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["m1"]);
		expect((h.current.value as { loadError?: string | null }).loadError ?? null).toBeNull();
		expect(timers.some((t) => t.ms === 1000)).toBe(true);
		await h.unmount();
	});
});

describe("what keys a paged list", () => {
	test("the scratch toggle is part of the request: flipping it reloads from the server", async () => {
		const seen: Array<boolean | undefined> = [];
		client.getSessions = (q: { excludeScratch?: boolean }) => {
			seen.push(q.excludeScratch);
			return Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			{ owner: "me", excludeScratch: false },
		);
		await h.render({ owner: "me", excludeScratch: false });
		await flush();
		await h.render({ owner: "me", excludeScratch: true });
		await flush();
		expect(seen).toEqual([undefined, true]);
		await h.unmount();
	});

	test("going away and coming back to a view doesn't re-show its old rows while the new answer is pending", async () => {
		const again = deferred<unknown>();
		let calls = 0;
		client.getSessions = () => {
			calls += 1;
			return calls === 1
				? Promise.resolve({ sessions: [sess("old")], total: 1 })
				: calls === 2
					? new Promise(() => {})
					: again.promise;
		};
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s),
			mine,
		);
		await h.render(mine);
		await flush();
		expect(h.current.value?.rows.length).toBe(1);
		await h.render(all);
		await h.render(mine);
		expect(h.current.value?.rows).toEqual([]);
		expect(h.current.value?.loading).toBe(true);
		again.resolve({ sessions: [sess("new")], total: 1 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["new"]);
		await h.unmount();
	});
});

describe("a resting pointer doesn't hold a refresh back for ever", () => {
	const realSetTimeout = globalThis.setTimeout;
	const realNow = Date.now;
	afterEach(() => {
		globalThis.setTimeout = realSetTimeout;
		Date.now = realNow;
	});

	test("a refresh deferred because the grid is hovered runs once the hold has lasted its limit", async () => {
		let reads = 0;
		client.getSessions = () => {
			reads += 1;
			return Promise.resolve({ sessions: [sess("m1")], total: 1 });
		};
		const h = renderHook(
			(s: DashboardScope) => useOperationalSessionList("waiting", () => true, "", s),
			mine,
		);
		await h.render(mine);
		await flush();
		expect(reads).toBe(1);
		let clock = 1_000_000;
		Date.now = () => clock;
		const queue: Array<{ cb: () => void; ms: number }> = [];
		// biome-ignore lint/suspicious/noExplicitAny: capturing the timers the refresh asks for
		(globalThis as any).setTimeout = (cb: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms !== undefined && ms >= 100 && ms <= REFRESH_DEBOUNCE_MS) {
				queue.push({ cb, ms });
				return 0;
			}
			return realSetTimeout(cb, ms, ...rest);
		};
		await act(async () => h.current.value?.scheduleRefresh());
		for (let i = 0; i < 40 && queue.length > 0 && reads === 1; i++) {
			const next = queue.shift();
			clock += next?.ms ?? 0;
			await act(async () => next?.cb());
		}
		await flush();
		expect(reads).toBe(2);
		await h.unmount();
	});
});
