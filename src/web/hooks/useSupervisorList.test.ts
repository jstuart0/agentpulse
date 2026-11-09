/**
 * The Hosts page's list, through the hook itself (no DOM): answers land in order, the flags end when they
 * should, and the quiet refetch is a background request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { api } from "../lib/api.js";
import {
	deferred,
	installDomStubs,
	removeDomStubs,
	renderHook,
} from "../test-utils/render-hook.js";
import { useSupervisorList } from "./useSupervisorList.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
afterEach(() => {
	client.getSupervisors = real.getSupervisors;
});

type Answer = { supervisors: SupervisorRecord[] };
const list = (...ids: string[]): Answer => ({
	supervisors: ids.map((id) => ({ id }) as unknown as SupervisorRecord),
});

function setup() {
	const calls: Array<{ opts: { background?: boolean }; d: ReturnType<typeof deferred<Answer>> }> =
		[];
	client.getSupervisors = (opts: { background?: boolean }) => {
		const d = deferred<Answer>();
		calls.push({ opts, d });
		return d.promise;
	};
	let fresh = 0;
	const h = renderHook((_: null) => useSupervisorList({ onFresh: () => fresh++ }), null);
	const state = () => h.current.value as ReturnType<typeof useSupervisorList>;
	const start = async (initial = false, quiet = false) => {
		let p!: Promise<boolean>;
		await act(async () => {
			p = state().load(initial, quiet);
		});
		return { done: p };
	};
	const answer = async (i: number, v: Answer | Error) => {
		await act(async () => {
			const d = (calls[i] as (typeof calls)[number]).d;
			if (v instanceof Error) d.reject(v);
			else d.resolve(v);
			await Promise.resolve();
			await Promise.resolve();
		});
	};
	return { calls, h, state, start, answer, fresh: () => fresh };
}

const ids = (s: ReturnType<typeof useSupervisorList>) => s.supervisors.map((x) => x.id);

describe("useSupervisorList", () => {
	test("(a) out of order: the older answer leaves the newer list and returns false", async () => {
		const w = setup();
		await w.h.render(null);
		const p1 = (await w.start()).done;
		const p2 = (await w.start()).done;
		await w.answer(1, list("new"));
		await w.answer(0, list("old"));
		expect(await p2).toBe(true);
		expect(await p1).toBe(false);
		expect(ids(w.state())).toEqual(["new"]);
		await w.h.unmount();
	});

	test("(b) a newer quiet failure, then an older success: the success applies and the flag clears", async () => {
		const w = setup();
		await w.h.render(null);
		const older = (await w.start(false, true)).done;
		const newer = (await w.start(false, true)).done;
		await w.answer(1, new Error("down"));
		expect(w.state().refreshFailed).toBe(true);
		await w.answer(0, list("a"));
		expect(await older).toBe(true);
		expect(await newer).toBe(false);
		expect(w.state().refreshFailed).toBe(false);
		expect(ids(w.state())).toEqual(["a"]);
		await w.h.unmount();
	});

	test("(c) an older failure after a newer success sets nothing", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start();
		await w.start();
		await w.answer(1, list("new"));
		await w.answer(0, new Error("late failure"));
		expect(w.state().loadError).toBeNull();
		expect(w.state().refreshFailed).toBe(false);
		await w.h.unmount();
	});

	test("(d) after the out-of-order pair, loading and refreshing are false", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start(true);
		await w.start();
		expect(w.state().loading).toBe(true);
		expect(w.state().refreshing).toBe(true);
		await w.answer(1, list("new"));
		await w.answer(0, list("old"));
		expect(w.state().loading).toBe(false);
		expect(w.state().refreshing).toBe(false);
		await w.h.unmount();
	});

	test("(e) a person's refresh keeps refreshing true while a quiet request lands first", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start(); // the person's
		await w.start(false, true); // quiet
		await w.answer(1, list("q"));
		expect(w.state().refreshing).toBe(true);
		await w.answer(0, list("p"));
		expect(w.state().refreshing).toBe(false);
		await w.h.unmount();
	});

	test("(f) a quiet failure sets refreshFailed, not loadError; a non-quiet failure sets loadError", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start(false, true);
		await w.answer(0, new Error("x"));
		expect(w.state().refreshFailed).toBe(true);
		expect(w.state().loadError).toBeNull();
		await w.start();
		await w.answer(1, new Error("y"));
		expect(w.state().loadError).toBe("Couldn't load hosts: network error");
		await w.h.unmount();
	});

	test("(g) the api receives background:true for quiet and false otherwise", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start(false, true);
		await w.start();
		expect(w.calls.map((c) => c.opts)).toEqual([{ background: true }, { background: false }]);
		await w.h.unmount();
	});

	test("(h) onFresh is called on a claimed success only", async () => {
		const w = setup();
		await w.h.render(null);
		await w.start();
		await w.start();
		await w.start();
		await w.answer(1, list("n"));
		expect(w.fresh()).toBe(1);
		await w.answer(0, list("stale"));
		expect(w.fresh()).toBe(1);
		await w.answer(2, new Error("fail"));
		expect(w.fresh()).toBe(1);
		await w.h.unmount();
	});

	test("(i) an answer after unmount sets nothing", async () => {
		const w = setup();
		await w.h.render(null);
		const p = (await w.start()).done;
		await w.h.unmount();
		await w.answer(0, list("late"));
		expect(await p).toBe(false);
		expect(w.fresh()).toBe(0);
	});
});
