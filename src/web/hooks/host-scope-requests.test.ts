/**
 * The machine filter travels with the scope: the list, the stats, the status and
 * tab lists, Load more, the per-owner headers, "Mark all as seen" and the team
 * line all send the same `host`, and every one of them refuses an answer that
 * says it applied a different machine, or none when one was asked for. Each
 * refusal is what the page would otherwise show wrongly: another machine's
 * sessions under this machine's label, or a mark-all that reaches past the view.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import { HOST_UNKNOWN } from "../lib/host-scope.js";
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
import { useMachineStats } from "./useMachineStats.js";
import { useOperationalSessionList } from "./useOperationalSessionList.js";
import { useOwnerGroupStats } from "./useOwnerGroupStats.js";
import { useSessions } from "./useSessions.js";
import { useTabSessionList } from "./useTabSessionList.js";

const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";
const scope: DashboardScope = { owner: ALICE, excludeScratch: true, host: "build-01" };

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const asked: Array<{ call: string; host?: string; owner?: string; excludeScratch?: boolean }> = [];
let intervals: Array<() => void> = [];
const realSetInterval = globalThis.setInterval;
const FOLLOW_REQUEST = Symbol("follow the request");
/** What every answer claims to have applied: by default what was asked, as a server would; a test sets it to say something else. */
let echo: unknown = FOLLOW_REQUEST;
function appliedFor(query: { host?: string }): unknown {
	if (echo !== FOLLOW_REQUEST) return echo;
	if (!query.host) return { kind: "all" };
	return query.host === HOST_UNKNOWN ? { kind: "unknown" } : { kind: "host", host: query.host };
}

function record(call: string, query: ScopedQuery) {
	asked.push({ call, host: query.host, owner: query.owner, excludeScratch: query.excludeScratch });
}

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(() => {
	asked.length = 0;
	intervals = [];
	echo = FOLLOW_REQUEST;
	useUserStore.setState({ userId: "viewer", mode: "team" } as never);
	useSessionStore.getState().resetForScope("reset");
	const stats = (query: { host?: string }) => ({
		operational: { waiting: 1, working: 0, idle: 0, error: 0 },
		hostFilter: appliedFor(query),
	});
	client.getSessions = (query: ScopedQuery) => {
		record(query.operational ? `list:${query.operational}` : query.q ? "search" : "list", query);
		return Promise.resolve({
			sessions: [{ sessionId: "s-1", ownerUserId: ALICE, machine: "build-01" }],
			total: 1,
			hostFilter: appliedFor(query),
		});
	};
	client.getStats = (query: ScopedQuery) => {
		record("stats", query);
		return Promise.resolve(stats(query));
	};
	client.getStatsByOwner = (query: ScopedQuery) => {
		record("groups", query);
		return Promise.resolve({ groups: [], hostFilter: appliedFor(query) });
	};
	client.getStatsByHost = (query: ScopedQuery) => {
		record("machines", query);
		return Promise.resolve({ groups: [], truncated: false, hostFilter: appliedFor(query) });
	};
	client.getEveryoneStats = (excludeScratch: boolean, host?: string) => {
		asked.push({ call: "everyone", host, excludeScratch });
		return Promise.resolve(stats({ host }));
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

describe("one scope, one machine in every request", () => {
	test("the list, stats, poll, status list, tab list, group stats and mark-all paging all send the machine", async () => {
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
		expect(new Set(asked.map((e) => e.call))).toEqual(
			new Set(["list", "stats", "list:waiting", "search", "groups"]),
		);
		for (const entry of asked) {
			expect({ call: entry.call, host: entry.host, owner: entry.owner }).toEqual({
				call: entry.call,
				host: "build-01",
				owner: ALICE,
			});
		}
		await hooks.unmount();
	});

	test("under Mine, the team line is asked for the same machine", async () => {
		const mineOnBuild: DashboardScope = { owner: "me", excludeScratch: true, host: "build-01" };
		const hook = renderHook((s: DashboardScope) => useSessions(s), mineOnBuild);
		await hook.render(mineOnBuild);
		await flush();
		expect(asked.filter((e) => e.call === "everyone")).toEqual([
			{ call: "everyone", host: "build-01", excludeScratch: true },
		]);
		await hook.unmount();
	});

	test("every machine sends no host at all, and unknown sends the reserved token", () => {
		expect(scopedQuery({ owner: "all", excludeScratch: false }).host).toBeUndefined();
		expect(scopedQuery({ owner: "all", excludeScratch: false, host: "" }).host).toBeUndefined();
		expect(scopedQuery({ owner: "all", excludeScratch: false, host: HOST_UNKNOWN }).host).toBe(
			HOST_UNKNOWN,
		);
	});
});

describe("an answer for another machine is refused", () => {
	const wrong = [
		["another machine", { kind: "host", host: "edge-02" }],
		["every machine", { kind: "all" }],
		["unknown", { kind: "unknown" }],
		["nothing (a server that doesn't know the parameter)", undefined],
	] as const;

	for (const [name, claimed] of wrong) {
		test(`the tab list refuses an answer that applied ${name}`, async () => {
			echo = claimed;
			const hook = renderHook(
				(s: DashboardScope) => useTabSessionList("active", undefined, "", s),
				scope,
			);
			await hook.render(scope);
			await flush();
			expect(hook.current.value?.rows).toEqual([]);
			expect(hook.current.value?.error).not.toBeNull();
			await hook.unmount();
		});
	}

	test("the status list, the poll, Mark all and the owner headers refuse it too", async () => {
		echo = { kind: "host", host: "edge-02" };
		const hooks = renderHook(
			(s: DashboardScope) => ({
				operational: useOperationalSessionList("waiting", undefined, "", s),
				sessions: useSessions(s),
				waiting: useAllWaitingSessions(s, 3),
				groups: useOwnerGroupStats(s, true),
			}),
			scope,
		);
		await hooks.render(scope);
		await flush(MARK_ALL_SETTLE_MS + TIMER_MARGIN_MS);
		const { operational, sessions, waiting, groups } = hooks.current.value ?? ({} as never);
		expect(operational.rows).toEqual([]);
		expect(operational.error).not.toBeNull();
		expect(sessions.sessions).toEqual([]);
		expect(sessions.stats).toBeNull();
		expect(sessions.scopeMismatch).toBe(true);
		expect(waiting).toEqual([]);
		expect(groups.groups).toBeNull();
		await hooks.unmount();
	});

	test("the matching answer is accepted (the control for the refusals above)", async () => {
		const hooks = renderHook(
			(s: DashboardScope) => ({
				tab: useTabSessionList("active", undefined, "", s),
				sessions: useSessions(s),
			}),
			scope,
		);
		await hooks.render(scope);
		await flush();
		expect(hooks.current.value?.tab.rows.map((r) => r.sessionId)).toEqual(["s-1"]);
		expect(hooks.current.value?.sessions.scopeMismatch).toBe(false);
		expect(hooks.current.value?.sessions.stats).not.toBeNull();
		await hooks.unmount();
	});

	test("with no machine asked for, an older server's silence is fine", async () => {
		echo = undefined;
		const every: DashboardScope = { owner: ALICE, excludeScratch: true };
		const hooks = renderHook(
			(s: DashboardScope) => ({
				tab: useTabSessionList("active", undefined, "", s),
				sessions: useSessions(s),
			}),
			every,
		);
		await hooks.render(every);
		await flush();
		expect(hooks.current.value?.tab.error).toBeNull();
		expect(hooks.current.value?.sessions.scopeMismatch).toBe(false);
		await hooks.unmount();
	});
});

describe("a switch of machine never lets the old machine's answer land", () => {
	test("the poll's list from the old machine is dropped once the machine changed", async () => {
		let release: (() => void) | null = null;
		client.getSessions = (query: ScopedQuery) =>
			new Promise((resolve) => {
				const answer = () =>
					resolve({
						sessions: [{ sessionId: `on-${query.host}`, ownerUserId: ALICE, machine: query.host }],
						total: 1,
						hostFilter: { kind: "host", host: query.host },
					});
				if (query.host === "build-01") release = answer;
				else answer();
			});
		const onBuild = scope;
		const onEdge: DashboardScope = { ...scope, host: "edge-02" };
		const hook = renderHook((s: DashboardScope) => useSessions(s), onBuild);
		try {
			await hook.render(onBuild);
			await hook.render(onEdge);
			await flush();
			expect(hook.current.value?.sessions.map((s) => s.sessionId)).toEqual(["on-edge-02"]);
			act(() => release?.());
			await flush();
			expect(hook.current.value?.sessions.map((s) => s.sessionId)).toEqual(["on-edge-02"]);
		} finally {
			await hook.unmount();
		}
	});
});

describe("useMachineStats: the machines the filter offers", () => {
	test("asks for every machine, in the owner scope and scratch setting on screen, and hands back the groups", async () => {
		client.getStatsByHost = (query: ScopedQuery) => {
			record("machines", query);
			return Promise.resolve({
				groups: [
					{ host: "build-01", total: 4 },
					{ host: null, total: 1 },
				],
				truncated: false,
				ownerScope: { kind: "user", userId: ALICE },
				hostFilter: { kind: "all" },
			});
		};
		const hook = renderHook((args: { s: DashboardScope | null }) => useMachineStats(args.s), {
			s: scope,
		});
		await hook.render({ s: scope });
		await flush();
		expect(asked).toEqual([
			{ call: "machines", host: undefined, owner: ALICE, excludeScratch: true },
		]);
		expect(hook.current.value?.groups?.map((g) => g.host)).toEqual(["build-01", null]);
		await hook.unmount();
	});

	test("nothing is asked before the scope is known, and nothing from another scope or a filtered answer is kept", async () => {
		const hook = renderHook<{ s: DashboardScope | null }, ReturnType<typeof useMachineStats>>(
			(args) => useMachineStats(args.s),
			{ s: null },
		);
		await hook.render({ s: null });
		await flush();
		expect(asked).toEqual([]);
		expect(hook.current.value?.groups).toBeNull();

		client.getStatsByHost = () =>
			Promise.resolve({
				groups: [{ host: "build-01", total: 4 }],
				truncated: false,
				hostFilter: { kind: "host", host: "build-01" },
			});
		await hook.render({ s: scope });
		await flush();
		expect(hook.current.value?.groups).toBeNull();
		await hook.unmount();
	});
});
