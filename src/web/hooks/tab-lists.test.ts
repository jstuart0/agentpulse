import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import { type ScopedQuery, scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";
import {
	TIMER_MARGIN_MS,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { PAGE_SIZE, REFRESH_DEBOUNCE_MS } from "./useScopedPagedList.js";
import { useTabSessionList } from "./useTabSessionList.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const scope: DashboardScope = { owner: "all", excludeScratch: true };

type Kind = "active" | "completed" | "archived";

// biome-ignore lint/suspicious/noExplicitAny: hand-built rows stand in for the server's DTO
function row(id: string, kind: Kind): any {
	return {
		sessionId: id,
		status: kind === "completed" ? "completed" : "active",
		isArchived: kind === "archived",
		isWorking: kind === "active",
		endedAt: kind === "completed" ? "2026-10-02T10:00:00Z" : null,
		lastUserAcknowledgedAt: null,
		lastActivityAt: "2026-10-02T10:00:00Z",
		cwd: "/w",
		agentType: "claude_code",
	};
}

/** A scope of sessions, newest first, that answers like the server: `tab=` is applied before paging. */
function serve(kinds: Kind[], seen: ScopedQuery[] = []) {
	const all = kinds.map((kind, i) => row(`s${i}`, kind));
	client.getSessions = (query: ScopedQuery) => {
		seen.push(query);
		const rows = query.tab ? all.filter((r) => kindOf(r) === query.tab) : all;
		const offset = query.offset ?? 0;
		return Promise.resolve({
			sessions: rows.slice(offset, offset + (query.limit ?? 50)),
			total: rows.length,
		});
	};
	return { all, seen };
}

// biome-ignore lint/suspicious/noExplicitAny: reading the hand-built row
function kindOf(r: any): Kind {
	return r.isArchived ? "archived" : r.status === "completed" ? "completed" : "active";
}

const hook = (tab: Parameters<typeof useTabSessionList>[0], search = "") =>
	renderHook((s: DashboardScope) => useTabSessionList(tab, undefined, search, s), scope);

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
beforeEach(() => useUserStore.setState({ userId: "me-id", mode: "team" } as never));
afterEach(() => Object.assign(api, real));

describe("a tab is listed by the server", () => {
	test("one request per step, asking for the tab, a page of rows and the start", async () => {
		const { seen } = serve(
			Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? "archived" : "active")),
		);
		const h = hook("archived");
		await h.render(scope);
		await flush();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ tab: "archived", limit: PAGE_SIZE, offset: 0 });
		expect(h.current.value?.rows).toHaveLength(10);
		expect(h.current.value?.total).toBe(10);
		expect(h.current.value?.canLoadMore).toBe(false);
		await h.unmount();
	});

	test("3 archived sessions at the very end of 20,000 are found in one request", async () => {
		const kinds: Kind[] = Array.from({ length: 20_000 }, () => "active");
		for (const at of [19_000, 19_500, 19_999]) kinds[at] = "archived";
		const { seen } = serve(kinds);
		const h = hook("archived");
		await h.render(scope);
		await flush();
		expect(seen).toHaveLength(1);
		expect(h.current.value?.rows).toHaveLength(3);
		expect(h.current.value?.canLoadMore).toBe(false);
		await h.unmount();
	});

	test("Load more asks for the next rows by offset and adds none twice", async () => {
		const { seen } = serve(Array.from({ length: 250 }, () => "completed"));
		const h = hook("completed");
		await h.render(scope);
		await flush();
		expect(h.current.value?.rows).toHaveLength(PAGE_SIZE);
		expect(h.current.value?.canLoadMore).toBe(true);
		await h.current.value?.loadMore();
		await flush();
		expect(seen[1]).toMatchObject({ tab: "completed", offset: PAGE_SIZE });
		const ids = h.current.value?.rows.map((r) => r.sessionId) ?? [];
		expect(ids).toHaveLength(PAGE_SIZE * 2);
		expect(new Set(ids).size).toBe(ids.length);
		await h.unmount();
	});

	test("the search term goes to the server with the tab", async () => {
		const { seen } = serve(["active"]);
		const h = hook("active", "billing");
		await h.render(scope);
		await flush();
		expect(seen[0]).toMatchObject({ tab: "active", q: "billing" });
		await h.unmount();
	});
});

describe("page size", () => {
	test("every tab opens with 100 rows and Load more adds 100, in solo and in team", async () => {
		for (const mode of ["solo", "team"] as const) {
			useUserStore.setState({ userId: "me-id", mode } as never);
			for (const tab of ["active", "completed", "archived", "all"] as const) {
				const kind: Kind = tab === "all" ? "active" : tab;
				const { seen } = serve(Array.from({ length: 250 }, () => kind));
				const h = hook(tab);
				await h.render(scope);
				await flush();
				expect(seen[0]).toMatchObject({ limit: 100, offset: 0 });
				expect(h.current.value?.rows).toHaveLength(100);
				await h.current.value?.loadMore();
				await flush();
				expect(seen[1]).toMatchObject({ offset: 100, limit: 100 });
				expect(h.current.value?.rows).toHaveLength(200);
				await h.unmount();
			}
		}
	});

	test("a list of 100 rows or fewer has no Load more", async () => {
		serve(Array.from({ length: 100 }, () => "active"));
		const h = hook("active");
		await h.render(scope);
		await flush();
		expect(h.current.value?.rows).toHaveLength(100);
		expect(h.current.value?.canLoadMore).toBe(false);
		await h.unmount();
	});
});

describe("the end of a tab", () => {
	test("a tab whose size is an exact number of pages is complete after the last page", async () => {
		serve(Array.from({ length: PAGE_SIZE * 2 }, () => "completed"));
		const h = hook("completed");
		await h.render(scope);
		await flush();
		await h.current.value?.loadMore();
		await flush();
		expect(h.current.value?.rows).toHaveLength(PAGE_SIZE * 2);
		expect(h.current.value?.canLoadMore).toBe(false);
		await h.unmount();
	});
});

describe("the request on the wire", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("carries the tab as a query parameter, and none for the All tab", async () => {
		const urls: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			urls.push(String(input));
			return Promise.resolve(
				new Response(JSON.stringify({ sessions: [], total: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;
		await api.getSessions(scopedQuery(scope, { tab: "archived", limit: 24 }));
		await api.getSessions(scopedQuery(scope, { limit: 24 }));
		expect(urls[0]).toContain("tab=archived");
		expect(urls[1]).not.toContain("tab=");
	});
});

describe("a refresh keeps the rows already loaded", () => {
	test("a tab loaded deeper than one page is re-read to the same depth, and does not shrink", async () => {
		const { seen } = serve(Array.from({ length: 250 }, () => "archived"));
		const h = hook("archived");
		await h.render(scope);
		await flush();
		await h.current.value?.loadMore();
		await flush();
		expect(h.current.value?.rows).toHaveLength(PAGE_SIZE * 2);
		const before = seen.length;
		await act(async () => h.current.value?.scheduleRefresh());
		await flush(REFRESH_DEBOUNCE_MS + TIMER_MARGIN_MS);
		expect(seen[before]).toMatchObject({ tab: "archived", offset: 0, limit: PAGE_SIZE * 2 });
		expect(h.current.value?.rows).toHaveLength(PAGE_SIZE * 2);
		await h.unmount();
	});

	test("3 rows found after Load more are still 3 after a live change elsewhere", async () => {
		const kinds: Kind[] = Array.from({ length: 5000 }, () => "active");
		for (const at of [4000, 4500, 4999]) kinds[at] = "archived";
		serve(kinds);
		const h = hook("archived");
		await h.render(scope);
		await flush();
		expect(h.current.value?.rows).toHaveLength(3);
		await act(async () => h.current.value?.scheduleRefresh());
		await flush(REFRESH_DEBOUNCE_MS + TIMER_MARGIN_MS);
		expect(h.current.value?.rows).toHaveLength(3);
		await h.unmount();
	});
});

describe("the All tab pages like the others", () => {
	test("it is the plain list: no tab parameter, Load more, and archived rows left out", async () => {
		const kinds: Kind[] = Array.from({ length: 300 }, (_, i) =>
			i % 5 === 0 ? "archived" : i % 2 ? "active" : "completed",
		);
		const { seen } = serve(kinds);
		const h = hook("all");
		await h.render(scope);
		await flush();
		expect(seen[0].tab).toBeUndefined();
		expect(seen[0]).toMatchObject({ limit: PAGE_SIZE, offset: 0 });
		expect(h.current.value?.total).toBe(300);
		expect(h.current.value?.rows.every((r) => !r.isArchived)).toBe(true);
		expect(h.current.value?.canLoadMore).toBe(true);
		while (h.current.value?.canLoadMore) {
			await h.current.value?.loadMore();
			await flush();
		}
		expect(h.current.value?.rows).toHaveLength(240);
		await h.unmount();
	});

	test("it never lists fewer sessions than Active does", async () => {
		const kinds: Kind[] = Array.from({ length: 200 }, (_, i) =>
			i % 3 === 0 ? "archived" : i % 2 ? "active" : "completed",
		);
		serve(kinds);
		const active = hook("active");
		const everything = hook("all");
		await active.render(scope);
		await everything.render(scope);
		await flush();
		for (const h of [active, everything]) {
			while (h.current.value?.canLoadMore) {
				await h.current.value?.loadMore();
				await flush();
			}
		}
		const activeIds = new Set(active.current.value?.rows.map((r) => r.sessionId));
		const allIds = new Set(everything.current.value?.rows.map((r) => r.sessionId));
		expect(allIds.size).toBeGreaterThanOrEqual(activeIds.size);
		for (const id of activeIds) expect(allIds.has(id)).toBe(true);
		await active.unmount();
		await everything.unmount();
	});

	test("a refresh re-reads every row consumed, so archived rows skipped over don't make it shrink", async () => {
		const kinds: Kind[] = Array.from({ length: 400 }, (_, i) => (i % 2 ? "archived" : "active"));
		const { seen } = serve(kinds);
		const h = hook("all");
		await h.render(scope);
		await flush();
		await h.current.value?.loadMore();
		await flush();
		const loaded = h.current.value?.rows.length ?? 0;
		const before = seen.length;
		await act(async () => h.current.value?.scheduleRefresh());
		await flush(REFRESH_DEBOUNCE_MS + TIMER_MARGIN_MS);
		expect(seen[before]).toMatchObject({ offset: 0, limit: PAGE_SIZE * 2 });
		expect(h.current.value?.rows.length).toBe(loaded);
		await h.unmount();
	});
});
