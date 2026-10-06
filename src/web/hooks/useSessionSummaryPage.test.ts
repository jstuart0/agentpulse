/**
 * AGEN-69 review T-3: the session page's whole summary wiring, as one hook: nothing is read while
 * the feature is off, availability is asked for on mount, announcements reach the live region, and
 * the fell-back line's Retry asks again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { SUMMARY_VIEW_FIXTURES as F } from "../../shared/__fixtures__/session-summary-view/index.js";
import { api } from "../lib/api.js";
import type { LabsFlags } from "../lib/api.js";
import { resetAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useSessionSummaryPage } from "./useSessionSummaryPage.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
let calls: Record<string, number>;
let flagOn = true;

beforeEach(() => {
	installDomStubs();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null, loading: false, error: null });
	calls = { summary: 0, labs: 0, ai: 0, post: 0 };
	client.getSessionSummary = async () => {
		calls.summary++;
		return F.empty;
	};
	client.generateSessionSummary = async () => {
		calls.post++;
		return {
			ok: true,
			body: {
				attempt: { status: "generating", startedAt: new Date().toISOString(), joined: false },
			},
		};
	};
	client.getAiStatus = async () => {
		calls.ai++;
		return { build: true, runtime: true, killSwitch: false, active: true };
	};
	client.getLabsFlags = async () => {
		calls.labs++;
		return { flags: { sessionSummary: flagOn } as unknown as LabsFlags, registry: [] };
	};
});
afterEach(() => {
	removeDomStubs();
	Object.assign(client, real);
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

async function mount(tab: string | null, announce: (t: string) => void = () => {}) {
	const p = renderHook(
		(t: string | null) => useSessionSummaryPage({ sessionId: "s1", tabParam: t, announce }),
		tab,
	);
	await p.render(tab);
	await flush(30);
	return p;
}

describe("useSessionSummaryPage", () => {
	test("on mount it asks for the flags and the AI status", async () => {
		const p = await mount(null);
		expect(calls.labs).toBe(1);
		expect(calls.ai).toBe(1);
		await p.unmount();
	});

	test("feature on: the summary is read once and the tab exists", async () => {
		flagOn = true;
		const p = await mount("summary");
		expect(calls.summary).toBe(1);
		expect(p.current.value?.route.summaryAvailable).toBe(true);
		expect(p.current.value?.route.workspaceTab).toBe("summary");
		await p.unmount();
	});

	test("feature off: the summary route is never called, and a Summary link falls back with the reason", async () => {
		flagOn = false;
		const p = await mount("summary");
		expect(calls.summary).toBe(0);
		expect(p.current.value?.route.fellBack).toEqual({ reason: "flag_off" });
		expect(p.current.value?.route.workspaceTab).toBe("activity");
		await p.unmount();
	});

	test("a started generation reaches the live region", async () => {
		flagOn = true;
		const said: string[] = [];
		const p = await mount(null, (t) => void said.push(t));
		await act(async () => void p.current.value?.summary.generate());
		await flush(30);
		expect(said).toContain("Summarizing");
		await p.unmount();
	});

	test("Retry on the fell-back line asks for availability again", async () => {
		flagOn = false;
		const p = await mount("summary");
		const before = calls.labs + calls.ai;
		useLabsStore.setState({ flags: null, error: "x" });
		await act(async () => p.current.value?.retryAvailability());
		await flush(30);
		expect(calls.labs + calls.ai).toBeGreaterThan(before);
		await p.unmount();
	});
});
