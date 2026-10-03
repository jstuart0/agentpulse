import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import type { DashboardScope } from "../lib/owner-scope.js";
import { type ScopedQuery, scopedQuery } from "../lib/scoped-query.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";
import {
	TIMER_MARGIN_MS,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { MARK_ALL_SETTLE_MS, useAllWaitingSessions } from "./useAllWaitingSessions.js";
import { useOperationalSessionList } from "./useOperationalSessionList.js";
import { useOwnerGroupStats } from "./useOwnerGroupStats.js";
import { useSessions } from "./useSessions.js";
import { useTabSessionList } from "./useTabSessionList.js";

const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";
const scope: DashboardScope = { owner: ALICE, excludeScratch: true };

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const asked: Array<{ call: string; owner?: string; excludeScratch?: boolean }> = [];
let intervals: Array<() => void> = [];
const realSetInterval = globalThis.setInterval;

function record(call: string, query: ScopedQuery) {
	asked.push({ call, owner: query.owner, excludeScratch: query.excludeScratch });
}

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(() => {
	asked.length = 0;
	intervals = [];
	useUserStore.setState({ userId: "viewer", mode: "team" } as never);
	useSessionStore.getState().resetForScope("reset");
	client.getSessions = (query: ScopedQuery) => {
		record(query.operational ? `list:${query.operational}` : query.q ? "search" : "list", query);
		return Promise.resolve({ sessions: [], total: 0 });
	};
	client.getStats = (query: ScopedQuery) => {
		record("stats", query);
		return Promise.resolve({ operational: { waiting: 1, working: 0, idle: 0, error: 0 } });
	};
	client.getStatsByOwner = (query: ScopedQuery) => {
		record("groups", query);
		return Promise.resolve({ groups: [] });
	};
	// biome-ignore lint/suspicious/noExplicitAny: replacing the timer for the test
	(globalThis as any).setInterval = (cb: () => void) => {
		intervals.push(cb);
		return intervals.length;
	};
});

afterEach(() => {
	Object.assign(api, real);
	globalThis.setInterval = realSetInterval;
});

describe("one scope, one set of request parameters", () => {
	test("the list, stats, poll, status list, tab list (with a search), group stats and mark-all paging all send the same scope", async () => {
		const hooks = renderHook(
			(s: DashboardScope) => ({
				sessions: useSessions(s),
				operational: useOperationalSessionList("waiting", undefined, "", s),
				tab: useTabSessionList("archived", undefined, "billing", s),
				groups: useOwnerGroupStats(s, true),
				waiting: useAllWaitingSessions(s, 3),
			}),
			scope,
		);
		await hooks.render(scope);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		await act(async () => {
			for (const tick of intervals) tick();
		});
		await flush();

		const calls = new Set(asked.map((entry) => entry.call));
		for (const expected of ["list", "stats", "list:waiting", "groups"]) {
			expect(calls.has(expected)).toBe(true);
		}
		expect(asked.length).toBeGreaterThan(6);
		for (const entry of asked) {
			expect({
				call: entry.call,
				owner: entry.owner,
				excludeScratch: entry.excludeScratch,
			}).toEqual({ call: entry.call, owner: ALICE, excludeScratch: true });
		}
		await hooks.unmount();
	});

	test("Everyone sends no owner at all and the scratch flag only when scratch is hidden", () => {
		const everyone = scopedQuery({ owner: "all", excludeScratch: false });
		expect(everyone.owner).toBeUndefined();
		expect(everyone.excludeScratch).toBeUndefined();
		const hidden = scopedQuery({ owner: "all", excludeScratch: true }, { limit: 5 });
		expect(hidden.excludeScratch).toBe(true);
		expect(hidden.limit).toBe(5);
	});
});

describe("scope is structural", () => {
	test("a plain object is not a scoped query, and filters cannot carry a scope of their own", () => {
		// The assertions are the compiler's: this file only typechecks while each
		// line below is an error.
		// @ts-expect-error a plain object has no brand
		void api.getSessions({ owner: "me", limit: 1 });
		// @ts-expect-error a plain object has no brand
		void api.getStats({ excludeScratch: true });
		// @ts-expect-error a plain object has no brand
		void api.getStatsByOwner({});
		// @ts-expect-error filters may not name the scope: only the scope argument can
		scopedQuery(scope, { owner: "me" });
		expect(true).toBe(true);
	});
});
