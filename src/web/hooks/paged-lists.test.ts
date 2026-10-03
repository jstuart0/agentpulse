import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import type { ScopedQuery } from "../lib/scoped-query.js";
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
import { useTabSessionList } from "./useTabSessionList.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const scope: DashboardScope = { owner: "all", excludeScratch: true };
const mine: DashboardScope = { owner: "me", excludeScratch: true };

// biome-ignore lint/suspicious/noExplicitAny: hand-built rows stand in for the server's DTO
function row(id: string, kind: "archived" | "completed" | "active" | "failed-dismissed"): any {
	return {
		sessionId: id,
		status: kind === "completed" ? "completed" : kind === "failed-dismissed" ? "failed" : "active",
		isArchived: kind === "archived",
		isWorking: kind === "active",
		endedAt: kind === "completed" || kind === "failed-dismissed" ? "2026-10-02T10:00:00Z" : null,
		lastUserAcknowledgedAt: kind === "failed-dismissed" ? "2026-10-02T11:00:00Z" : null,
		lastActivityAt: "2026-10-02T10:00:00Z",
		cwd: "/w",
		agentType: "claude_code",
	};
}

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => useUserStore.setState({ userId: "me-id", mode: "team" } as never));
afterEach(() => Object.assign(api, real));

describe("useTabSessionList", () => {
	test("inactive without a tab, and it sends the search term to the server", async () => {
		const terms: Array<string | undefined> = [];
		client.getSessions = (query: ScopedQuery) => {
			terms.push(query.q);
			return Promise.resolve({ sessions: [], total: 0 });
		};
		const off = renderHook((s: DashboardScope) => useTabSessionList(null, undefined, "", s), scope);
		await off.render(scope);
		await flush();
		expect(terms).toEqual([]);
		expect(off.current.value?.loading).toBe(false);
		await off.unmount();
		const on = renderHook(
			(s: DashboardScope) => useTabSessionList("completed", undefined, "billing", s),
			scope,
		);
		await on.render(scope);
		await flush();
		expect(terms).toEqual(["billing"]);
		await on.unmount();
	});
});

describe("useAllWaitingSessions", () => {
	test("the waiting set of the scope that was asked for; another scope's answer is dropped", async () => {
		const late = deferred<unknown>();
		client.getSessions = (query: ScopedQuery) =>
			query.owner === "me"
				? Promise.resolve({ sessions: [row("mine", "active")], total: 1 })
				: late.promise;
		const h = renderHook((s: DashboardScope) => useAllWaitingSessions(s, 3), scope);
		await h.render(scope);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		await h.render(mine);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		late.resolve({ sessions: [row("theirs", "active")], total: 1 });
		await flush();
		expect(h.current.value?.map((s) => s.sessionId)).toEqual(["mine"]);
		await h.unmount();
	});

	test("nothing is held for a scope whose answer hasn't arrived", async () => {
		const pending = deferred<unknown>();
		client.getSessions = (query: ScopedQuery) =>
			query.owner === "me"
				? pending.promise
				: Promise.resolve({ sessions: [row("a", "active")], total: 1 });
		const h = renderHook((s: DashboardScope) => useAllWaitingSessions(s, 3), scope);
		await h.render(scope);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		expect(h.current.value).toHaveLength(1);
		await h.render(mine);
		expect(h.current.value).toEqual([]);
		await h.unmount();
	});

	test("with no waiting sessions it holds nothing and asks nothing", async () => {
		let asked = 0;
		client.getSessions = () => {
			asked += 1;
			return Promise.resolve({ sessions: [], total: 0 });
		};
		const h = renderHook((s: DashboardScope) => useAllWaitingSessions(s, 0), scope);
		await h.render(scope);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		expect(asked).toBe(0);
		expect(h.current.value).toEqual([]);
		await h.unmount();
	});
});

describe("the paged list under changing answers", () => {
	const hook = (s: DashboardScope) => useOperationalSessionList("waiting", undefined, "", s);

	test("the new scope's first page landing before the old scope's doesn't get replaced by it", async () => {
		const old = deferred<unknown>();
		client.getSessions = (query: ScopedQuery) =>
			query.owner === "me"
				? Promise.resolve({ sessions: [row("mine", "active")], total: 1 })
				: old.promise;
		const h = renderHook(hook, scope);
		await h.render(scope);
		await h.render(mine);
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["mine"]);
		old.resolve({ sessions: [row("theirs", "active")], total: 1 });
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["mine"]);
		expect(h.current.value?.loading).toBe(false);
		await h.unmount();
	});

	test("Load more pages that overlap (rows moved while paging) add no row twice", async () => {
		client.getSessions = (query: ScopedQuery) => {
			const offset = query.offset ?? 0;
			const ids = offset === 0 ? ["a", "b", "c"] : ["c", "d"];
			return Promise.resolve({ sessions: ids.map((id) => row(id, "active")), total: 5 });
		};
		const h = renderHook(hook, scope);
		await h.render(scope);
		await flush();
		await h.current.value?.loadMore();
		await flush();
		expect(h.current.value?.rows.map((r) => r.sessionId)).toEqual(["a", "b", "c", "d"]);
		await h.unmount();
	});
});
