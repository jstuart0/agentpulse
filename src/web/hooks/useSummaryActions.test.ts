/** AGEN-69 review T-1: every click is tested: what is called, with what, and what is not. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { STORED } from "../../shared/__fixtures__/session-summary-view/index.js";
import {
	buildContextMarkdown,
	buildHandoffMarkdown,
	buildSummaryMarkdown,
} from "../lib/session-summary-view.js";
import { COPY_ANNOUNCEMENT } from "../lib/summary-copy.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import type { UseSessionSummary } from "./useSessionSummary.js";
import { useCopyActions, useGenerateClick } from "./useSummaryActions.js";

const META = { name: "demo", branch: "main", cwd: "/w" };
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let written: string[] = [];
function clipboard(ok: boolean) {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			clipboard: {
				writeText: async (t: string) => {
					if (!ok) throw new Error("denied");
					written.push(t);
				},
			},
		},
	});
}
beforeEach(() => {
	installDomStubs();
	written = [];
	clipboard(true);
});
afterEach(() => {
	removeDomStubs();
	if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});

function copyProbe(announced: string[]) {
	return renderHook(
		() =>
			useCopyActions({
				stored: STORED,
				meta: META,
				generatedAt: "2026-10-04T09:00:00.000Z",
				staleEvents: 0,
				announce: (t) => void announced.push(t),
			}),
		undefined,
	);
}

describe("copy actions", () => {
	test("each kind copies its own builder's text, once", async () => {
		const meta = { ...META, generatedAt: "2026-10-04T09:00:00.000Z", staleEvents: 0 };
		const expected = {
			handoff: buildHandoffMarkdown(STORED, meta),
			summary: buildSummaryMarkdown(STORED, meta),
			context: buildContextMarkdown(STORED),
		} as const;
		for (const kind of ["handoff", "summary", "context"] as const) {
			written = [];
			const p = copyProbe([]);
			await p.render(undefined);
			await act(async () => p.current.value?.copy(kind));
			expect(written, kind).toEqual([expected[kind]]);
			await p.unmount();
		}
		expect(new Set(Object.values(expected)).size).toBe(3);
	});

	test("success flashes Copied on that kind and announces it; a repeat is announced again", async () => {
		const said: string[] = [];
		const p = copyProbe(said);
		await p.render(undefined);
		await act(async () => p.current.value?.copy("summary"));
		expect(p.current.value?.copied).toBe("summary");
		await act(async () => p.current.value?.copy("summary"));
		expect(said.map((t) => t.trim())).toEqual([
			COPY_ANNOUNCEMENT.summary,
			COPY_ANNOUNCEMENT.summary,
		]);
		expect(said[0]).not.toBe(said[1]);
		await p.unmount();
	});

	test("a refused clipboard shows the text by hand, announces nothing and flashes nothing; closing clears it", async () => {
		clipboard(false);
		const said: string[] = [];
		const p = copyProbe(said);
		await p.render(undefined);
		await act(async () => p.current.value?.copy("handoff"));
		expect(p.current.value?.fallback).toContain("AI-generated from session activity");
		expect(p.current.value?.copied).toBeNull();
		expect(said).toEqual([]);
		await act(async () => p.current.value?.closeFallback());
		expect(p.current.value?.fallback).toBeNull();
		await p.unmount();
	});

	test("with nothing stored nothing is copied", async () => {
		const p = renderHook(() => useCopyActions({ stored: null }), undefined);
		await p.render(undefined);
		await act(async () => p.current.value?.copy("summary"));
		expect(written).toEqual([]);
		await p.unmount();
	});
});

describe("generate click", () => {
	function probe(answer: Awaited<ReturnType<UseSessionSummary["generate"]>>, counting = false) {
		const calls: Array<{ confirmed?: boolean } | undefined> = [];
		const p = renderHook(
			(c: boolean) =>
				useGenerateClick({
					generate: async (o) => {
						calls.push(o);
						return answer;
					},
					counting: c,
				}),
			counting,
		);
		return { calls, p, render: (c = counting) => p.render(c) };
	}

	test("a click calls generate once, unconfirmed", async () => {
		const t = probe("started");
		await t.render();
		await act(async () => t.p.current.value?.click());
		expect(t.calls).toEqual([undefined]);
		expect(t.p.current.value?.confirming).toBe(false);
		await t.p.unmount();
	});

	test("during a rate-limit countdown a click calls nothing", async () => {
		const t = probe("started", true);
		await t.render();
		await act(async () => t.p.current.value?.click());
		expect(t.calls).toEqual([]);
		await t.p.unmount();
	});

	test("needs_confirmation opens the dialog; Replace sends the confirmed request; Keep sends nothing", async () => {
		const t = probe("needs_confirmation");
		await t.render();
		await act(async () => t.p.current.value?.click());
		expect(t.p.current.value?.confirming).toBe(true);
		expect(t.calls).toEqual([undefined]);
		await act(async () => t.p.current.value?.cancel());
		expect(t.p.current.value?.confirming).toBe(false);
		expect(t.calls).toHaveLength(1);
		await act(async () => t.p.current.value?.click());
		await act(async () => t.p.current.value?.confirm());
		await flush();
		expect(t.calls.at(-1)).toEqual({ confirmed: true });
		expect(t.p.current.value?.confirming).toBe(false);
		await t.p.unmount();
	});
});
