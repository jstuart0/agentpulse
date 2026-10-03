import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
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
import { useOperationalSessionList } from "./useOperationalSessionList.js";
import { REFRESH_DEBOUNCE_MS } from "./useScopedPagedList.js";
import { useSessions } from "./useSessions.js";

/**
 * Whatever a request was asked for, its answer may only land while the view is
 * still the one that asked. Each test starts a request under one scope, changes
 * the scope, and then lets the old request finish.
 */
const ME = "me-id";
const ALICE = "alice-id";

// biome-ignore lint/suspicious/noExplicitAny: a hand-built row stands in for the server's DTO
function sess(id: string, owner: string | null): any {
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

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
let intervals: Array<{ cb: () => void; id: number }> = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

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
	intervals = [];
	client.getEveryoneStats = () => Promise.resolve(stats(0));
	// biome-ignore lint/suspicious/noExplicitAny: replacing the timer for the test
	(globalThis as any).setInterval = (cb: () => void, _ms: number) => {
		const id = intervals.length + 1;
		intervals.push({ cb, id });
		return id;
	};
	// biome-ignore lint/suspicious/noExplicitAny: replacing the timer for the test
	(globalThis as any).clearInterval = (id: number) => {
		intervals = intervals.filter((i) => i.id !== id);
	};
});

afterEach(() => {
	Object.assign(api, real);
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
	intervals = [];
});

const all: DashboardScope = { owner: "all", excludeScratch: true };
const mine: DashboardScope = { owner: "me", excludeScratch: true };

describe("useSessions", () => {
	test("a late list response for the old scope doesn't overwrite the new scope's data", async () => {
		const late = deferred<unknown>();
		client.getSessions = (q: { owner?: string }) =>
			q.owner === "me" ? Promise.resolve({ sessions: [sess("m1", ME)], total: 1 }) : late.promise;
		client.getStats = (q: { owner?: string }) => Promise.resolve(stats(q.owner === "me" ? 1 : 9));
		const h = renderHook((s: DashboardScope) => useSessions(s), all);
		await h.render(all);
		await h.render(mine);
		await flush();
		late.resolve({ sessions: [sess("a1", ALICE), sess("a2", ALICE)], total: 2 });
		await flush();
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["m1"]);
		expect(useSessionStore.getState().stats?.operational.waiting).toBe(1);
		await h.unmount();
	});

	test("a poll in flight for the old scope doesn't overwrite after a switch", async () => {
		const poll = deferred<unknown>();
		let call = 0;
		client.getSessions = (q: { owner?: string }) => {
			call++;
			if (q.owner === "me") return Promise.resolve({ sessions: [sess("m1", ME)], total: 1 });
			return call === 1
				? Promise.resolve({ sessions: [sess("a1", ALICE)], total: 1 })
				: poll.promise;
		};
		client.getStats = (q: { owner?: string }) => Promise.resolve(stats(q.owner === "me" ? 1 : 9));
		const h = renderHook((s: DashboardScope) => useSessions(s), all);
		await h.render(all);
		await flush();
		intervals[0].cb();
		await h.render(mine);
		await flush();
		poll.resolve({ sessions: [sess("a1", ALICE), sess("a9", ALICE)], total: 2 });
		await flush();
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["m1"]);
		await h.unmount();
	});

	test("a refused echo clears the data and flags a mismatch; the next good poll recovers", async () => {
		let bad = true;
		client.getSessions = () =>
			Promise.resolve({
				sessions: [sess("a1", ALICE)],
				total: 1,
				ownerScope: bad ? { kind: "unassigned" } : { kind: "user", userId: ME },
			});
		client.getStats = () => Promise.resolve(stats(1));
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		expect(h.current.value?.scopeMismatch).toBe(true);
		expect(useSessionStore.getState().sessions).toEqual([]);
		bad = false;
		intervals[0].cb();
		await flush();
		expect(h.current.value?.scopeMismatch).toBe(false);
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["a1"]);
		await h.unmount();
	});

	test("no echo at all is accepted (an older server)", async () => {
		client.getSessions = () => Promise.resolve({ sessions: [sess("m1", ME)], total: 1 });
		client.getStats = () => Promise.resolve(stats(1));
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		expect(h.current.value?.scopeMismatch).toBe(false);
		expect(useSessionStore.getState().sessions.length).toBe(1);
		await h.unmount();
	});

	test("idle requests per poll: Everyone makes 2, Mine makes 3", async () => {
		let n = 0;
		client.getSessions = () => {
			n++;
			return Promise.resolve({ sessions: [], total: 0 });
		};
		client.getStats = () => {
			n++;
			return Promise.resolve(stats(0));
		};
		client.getEveryoneStats = () => {
			n++;
			return Promise.resolve(stats(0));
		};
		const h = renderHook((s: DashboardScope) => useSessions(s), all);
		await h.render(all);
		await flush();
		const everyone = n;
		n = 0;
		intervals[0].cb();
		await flush();
		const everyonePoll = n;
		await h.render(mine);
		await flush();
		n = 0;
		intervals[intervals.length - 1].cb();
		await flush();
		expect([everyone, everyonePoll, n]).toEqual([2, 2, 3]);
		await h.unmount();
	});

	test("while the new scope's first answer is pending, the old rows and counts are gone and loading stays true", async () => {
		const pending = deferred<unknown>();
		client.getSessions = (q: { owner?: string }) =>
			q.owner === "me"
				? pending.promise
				: Promise.resolve({ sessions: [sess("a1", ALICE)], total: 1 });
		client.getStats = () => Promise.resolve(stats(4));
		const h = renderHook((s: DashboardScope) => useSessions(s), all);
		await h.render(all);
		await flush();
		expect(useSessionStore.getState().sessions.length).toBe(1);
		await h.render(mine);
		await flush();
		expect(useSessionStore.getState().sessions).toEqual([]);
		expect(useSessionStore.getState().stats).toBeNull();
		expect(h.current.value?.isLoading).toBe(true);
		pending.resolve({ sessions: [sess("m1", ME)], total: 1 });
		await flush();
		expect(h.current.value?.isLoading).toBe(false);
		await h.unmount();
	});

	test("the debounced counts refresh from the old scope is dropped after a switch, whatever it echoes", async () => {
		const lateStats = deferred<unknown>();
		let refreshing = false;
		client.getSessions = () => Promise.resolve({ sessions: [], total: 0 });
		client.getStats = (q: { owner?: string }) => {
			if (q.owner === "me") return Promise.resolve(stats(1));
			return refreshing ? lateStats.promise : Promise.resolve(stats(9));
		};
		const h = renderHook((s: DashboardScope) => useSessions(s), all);
		await h.render(all);
		await flush();
		refreshing = true;
		// biome-ignore lint/suspicious/noExplicitAny: the refresh is the hook's own seam for the debounced refetch
		const refreshCounts = (h.current.value as any).refreshCounts as
			| (() => Promise<void>)
			| undefined;
		expect(typeof refreshCounts).toBe("function");
		void refreshCounts?.();
		await h.render(mine);
		await flush();
		lateStats.resolve(stats(9, { ownerScope: { kind: "all" } }));
		await flush();
		expect(useSessionStore.getState().stats?.operational.waiting).toBe(1);
		await h.unmount();
	});

	test("the counts refresh fetches the scoped and the everyone stats together under Mine", async () => {
		const asked: string[] = [];
		client.getSessions = () => Promise.resolve({ sessions: [], total: 0 });
		client.getStats = (q: { owner?: string }) => {
			asked.push(`scoped:${q.owner ?? "all"}`);
			return Promise.resolve(stats(1));
		};
		client.getEveryoneStats = () => {
			asked.push("everyone");
			return Promise.resolve(stats(5));
		};
		const h = renderHook((s: DashboardScope) => useSessions(s), mine);
		await h.render(mine);
		await flush();
		asked.length = 0;
		// biome-ignore lint/suspicious/noExplicitAny: the refresh is the hook's own seam for the debounced refetch
		await act(async () => (h.current.value as any).refreshCounts?.());
		expect(asked.sort()).toEqual(["everyone", "scoped:me"]);
		await h.unmount();
	});
});

describe("useOperationalSessionList", () => {
	const hook = (s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s);

	test("loading stays true while the new scope's first page is in flight", async () => {
		const d1 = deferred<unknown>();
		const d2 = deferred<unknown>();
		client.getSessions = (q: { owner?: string }) => (q.owner === "me" ? d2.promise : d1.promise);
		const h = renderHook(hook, all);
		await h.render(all);
		await h.render(mine);
		d1.resolve({ sessions: [sess("a1", ALICE)], total: 1 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId) ?? []).not.toContain("a1");
		expect(h.current.value?.loading).toBe(true);
		d2.resolve({ sessions: [sess("m1", ME)], total: 1 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["m1"]);
		expect(h.current.value?.loading).toBe(false);
		await h.unmount();
	});

	test("rows of the old scope are not shown while the new scope's page loads", async () => {
		const d2 = deferred<unknown>();
		client.getSessions = (q: { owner?: string }) =>
			q.owner === "me" ? d2.promise : Promise.resolve({ sessions: [sess("a1", ALICE)], total: 1 });
		const h = renderHook(hook, all);
		await h.render(all);
		await flush();
		expect(h.current.value?.rows.length).toBe(1);
		await h.render(mine);
		expect(h.current.value?.rows.map((r) => r.sessionId) ?? []).not.toContain("a1");
		expect(h.current.value?.total ?? null).toBeNull();
		d2.resolve({ sessions: [], total: 0 });
		await flush();
		await h.unmount();
	});

	test("a Load more still in flight when the scope changes doesn't append the old scope's rows", async () => {
		const more = deferred<unknown>();
		client.getSessions = (q: { owner?: string; offset?: number }) => {
			if (q.owner === "me") return Promise.resolve({ sessions: [sess("m1", ME)], total: 1 });
			return (q.offset ?? 0) > 0
				? more.promise
				: Promise.resolve({ sessions: [sess("a1", ALICE)], total: 40 });
		};
		const h = renderHook(hook, all);
		await h.render(all);
		await flush();
		void h.current.value?.loadMore();
		await h.render(mine);
		await flush();
		more.resolve({ sessions: [sess("a2", ALICE)], total: 40 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["m1"]);
		expect(h.current.value?.total).toBe(1);
		await h.unmount();
	});

	test("a debounced refresh in flight when the scope changes doesn't overwrite the new rows", async () => {
		const refresh = deferred<unknown>();
		let call = 0;
		client.getSessions = (q: { owner?: string }) => {
			if (q.owner === "me") return Promise.resolve({ sessions: [sess("m1", ME)], total: 1 });
			call++;
			return call === 1
				? Promise.resolve({ sessions: [sess("a1", ALICE)], total: 1 })
				: refresh.promise;
		};
		const h = renderHook(hook, all);
		await h.render(all);
		await flush();
		h.current.value?.scheduleRefresh();
		await act(async () => {
			await new Promise((r) => setTimeout(r, REFRESH_DEBOUNCE_MS + TIMER_MARGIN_MS));
		});
		await h.render(mine);
		await flush();
		refresh.resolve({ sessions: [sess("a1", ALICE), sess("a2", ALICE)], total: 2 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["m1"]);
		await h.unmount();
	});

	test("a Load more for the same scope but an older search term is dropped", async () => {
		const more = deferred<unknown>();
		client.getSessions = (q: { q?: string; offset?: number }) => {
			if ((q.offset ?? 0) > 0) return more.promise;
			return Promise.resolve({
				sessions: [sess(q.q ? "found" : "a1", ALICE)],
				total: q.q ? 1 : 40,
			});
		};
		const h = renderHook(
			(p: { s: DashboardScope; q: string }) =>
				useOperationalSessionList("waiting", undefined, p.q, p.s),
			{ s: all, q: "" },
		);
		await h.render({ s: all, q: "" });
		await flush();
		void h.current.value?.loadMore();
		await h.render({ s: all, q: "billing" });
		await flush();
		more.resolve({ sessions: [sess("late", ALICE)], total: 40 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["found"]);
		await h.unmount();
	});
});

describe("the store reads the live scope", () => {
	test("the store itself refuses another user's row under Mine, and drops one that changed away", () => {
		useDashboardScopeStore.setState({ owner: "me", resolved: true });
		useSessionStore.setState({ sessions: [sess("m1", ME)] });
		useSessionStore.getState().applySessionUpdate(sess("a1", ALICE));
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["m1"]);
		useSessionStore.getState().applySessionUpdate(sess("m1", ALICE));
		expect(useSessionStore.getState().sessions).toEqual([]);
		useDashboardScopeStore.setState({ owner: "all", resolved: true });
	});

	test("addSession and updateSession are scoped too", () => {
		useDashboardScopeStore.setState({ owner: "me", resolved: true });
		useSessionStore.setState({ sessions: [sess("m1", ME)] });
		useSessionStore.getState().addSession(sess("a1", ALICE));
		useSessionStore.getState().updateSession(sess("m1", ALICE));
		expect(useSessionStore.getState().sessions).toEqual([]);
		useDashboardScopeStore.setState({ owner: "all", resolved: true });
	});

	test("the same row is accepted under Everyone and under its own owner's view", () => {
		useDashboardScopeStore.setState({ owner: "all", resolved: true });
		useSessionStore.setState({ sessions: [] });
		useSessionStore.getState().applySessionUpdate(sess("a1", ALICE));
		expect(useSessionStore.getState().sessions.length).toBe(1);
		useDashboardScopeStore.setState({ owner: ALICE, resolved: true });
		useSessionStore.getState().applySessionUpdate(sess("a2", ALICE));
		useSessionStore.getState().applySessionUpdate(sess("m1", ME));
		expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toEqual(["a2", "a1"]);
		useDashboardScopeStore.setState({ owner: "all", resolved: true });
	});
});
