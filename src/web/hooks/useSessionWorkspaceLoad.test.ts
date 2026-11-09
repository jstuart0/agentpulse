/**
 * The session page's loader, through the hook itself (no DOM): answers apply in order, an answer for a
 * session no longer shown is dropped, and the skeleton ends only when it should.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "../lib/api.js";
import {
	deferred,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { type SessionWorkspaceData, useSessionWorkspaceLoad } from "./useSessionWorkspaceLoad.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
afterEach(() => {
	client.getSession = real.getSession;
});

function data(tag: string): SessionWorkspaceData {
	return { session: { sessionId: tag }, events: [] } as unknown as SessionWorkspaceData;
}

type Call = { id: string; d: ReturnType<typeof deferred<SessionWorkspaceData>> };

function setup(initialId = "A") {
	const calls: Call[] = [];
	client.getSession = (id: string) => {
		const d = deferred<SessionWorkspaceData>();
		calls.push({ id, d });
		return d.promise;
	};
	const log = { loaded: [] as string[], failed: 0, settled: 0 };
	const h = renderHook(
		(p: { id: string }) => {
			return useSessionWorkspaceLoad(p.id, {
				loaded: (d) => log.loaded.push((d.session as { sessionId: string }).sessionId),
				failed: () => {
					log.failed++;
				},
				settled: () => {
					log.settled++;
				},
			});
		},
		{ id: initialId },
	);
	const api_ = () => h.current.value as ReturnType<typeof useSessionWorkspaceLoad>;
	const start = async () => {
		let p!: Promise<void>;
		await act(async () => {
			p = api_().load();
		});
		return { done: p };
	};
	const settle = async (c: Call, tag: string | Error) => {
		await act(async () => {
			if (tag instanceof Error) c.d.reject(tag);
			else c.d.resolve(data(tag));
			await Promise.resolve();
			await Promise.resolve();
		});
	};
	return { calls, log, h, api_, start, settle };
}

describe("useSessionWorkspaceLoad", () => {
	test("(a) out of order: only the newer answer is applied", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.start();
		await w.settle(w.calls[1] as Call, "new");
		await w.settle(w.calls[0] as Call, "old");
		expect(w.log.loaded).toEqual(["new"]);
		await w.h.unmount();
	});

	test("(b) in order: both apply, newer last", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.start();
		await w.settle(w.calls[0] as Call, "old");
		await w.settle(w.calls[1] as Call, "new");
		expect(w.log.loaded).toEqual(["old", "new"]);
		await w.h.unmount();
	});

	test("(c) starvation: three overlapping loads resolved oldest first all apply", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.start();
		await w.start();
		for (const [i, c] of w.calls.entries()) await w.settle(c, `r${i}`);
		expect(w.log.loaded).toEqual(["r0", "r1", "r2"]);
		await w.h.unmount();
	});

	test("(d) an answer for a session no longer shown is dropped", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.h.render({ id: "B" });
		await w.settle(w.calls[0] as Call, "A");
		expect(w.log.loaded).toEqual([]);
		expect(w.log.settled).toBe(0);
		await w.h.unmount();
	});

	test("(e) an older failure after a newer success is not reported", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.start();
		await w.settle(w.calls[1] as Call, "new");
		await w.settle(w.calls[0] as Call, new Error("boom"));
		expect(w.log.failed).toBe(0);
		await w.h.unmount();
	});

	test("(f) A to B to A: A1 failing while A2 is pending doesn't settle", async () => {
		const w = setup("A");
		await w.h.render({ id: "A" });
		await w.start(); // A1
		await w.h.render({ id: "B" });
		await w.h.render({ id: "A" });
		await w.start(); // A2
		await w.settle(w.calls[0] as Call, new Error("old failure"));
		expect(w.log.settled).toBe(0);
		await w.settle(w.calls[1] as Call, "A");
		expect(w.log.settled).toBe(1);
		expect(w.log.loaded).toEqual(["A"]);
		await w.h.unmount();
	});

	test("(g) markApplied drops an older load; a load begun after it applies", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		w.api_().markApplied();
		await w.start();
		await w.settle(w.calls[0] as Call, "old");
		expect(w.log.loaded).toEqual([]);
		await w.settle(w.calls[1] as Call, "fresh");
		expect(w.log.loaded).toEqual(["fresh"]);
		await w.h.unmount();
	});

	test("(h) a superseded answer still lets settled fire once nothing is pending", async () => {
		const w = setup();
		await w.h.render({ id: "A" });
		await w.start();
		await w.start();
		await w.settle(w.calls[1] as Call, "new");
		expect(w.log.settled).toBe(1);
		await w.settle(w.calls[0] as Call, "old");
		expect(w.log.loaded).toEqual(["new"]);
		expect(w.log.settled).toBe(2);
		await w.h.unmount();
	});
});
