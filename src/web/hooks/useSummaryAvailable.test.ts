import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { type AiStatusResponse, api } from "../lib/api.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import {
	reloadSummaryAvailability,
	useSummaryAvailability,
	useSummaryAvailable,
	useSummaryUnavailableReason,
} from "./useSummaryAvailable.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { getAiStatus: api.getAiStatus, getLabsFlags: api.getLabsFlags };

const AI_ON: AiStatusResponse = { build: true, runtime: true, killSwitch: false, active: true };

let aiCalls = 0;
let labsCalls = 0;

function setLabs(
	flags: Record<string, boolean> | null,
	error: string | null = null,
	loading = false,
) {
	// biome-ignore lint/suspicious/noExplicitAny: the flag joins LabsFlags in phase 5
	useLabsStore.setState({ flags: flags as any, error, loading });
}
function setAi(
	status: AiStatusResponse | null,
	loadState: "idle" | "loading" | "loaded" | "error",
) {
	useAiStatusStore.setState({ status, loadState, error: null });
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];
function track<T extends { unmount: () => Promise<void> }>(hook: T): T {
	mounted.push(hook);
	return hook;
}

function probe() {
	return track(
		renderHook(
			() => ({
				available: useSummaryAvailable(),
				state: useSummaryAvailability(),
				reason: useSummaryUnavailableReason(),
			}),
			undefined,
		),
	);
}

beforeEach(() => {
	installDomStubs();
	aiCalls = 0;
	labsCalls = 0;
	client.getAiStatus = async () => {
		aiCalls++;
		return AI_ON;
	};
	client.getLabsFlags = async () => {
		labsCalls++;
		return { flags: { sessionSummary: true }, registry: [] };
	};
	setLabs(null);
	setAi(null, "idle");
});
afterEach(async () => {
	for (const h of mounted.splice(0)) await h.unmount();
	removeDomStubs();
	client.getAiStatus = real.getAiStatus;
	client.getLabsFlags = real.getLabsFlags;
	setLabs(null);
	setAi(null, "idle");
});

describe("useSummaryAvailable", () => {
	test("TC-7.35a it follows the stores: pending, then available, then unavailable", async () => {
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toEqual({ available: false, state: "pending", reason: null });
		await act(async () => {
			setLabs({ sessionSummary: true });
			setAi(AI_ON, "loaded");
		});
		expect(h.current.value).toEqual({ available: true, state: "available", reason: null });
		await act(async () => setAi({ ...AI_ON, build: false }, "loaded"));
		expect(h.current.value).toEqual({
			available: false,
			state: "unavailable",
			reason: "not_built",
		});
		await h.unmount();
	});

	test("TC-7.35b it is a boolean selector: an unrelated store change causes no re-render", async () => {
		setLabs({ sessionSummary: true });
		setAi(AI_ON, "loaded");
		let renders = 0;
		const h = track(
			renderHook(() => {
				renders++;
				return useSummaryAvailable();
			}, undefined),
		);
		await h.render(undefined);
		await flush();
		const settled = renders;
		await act(async () => {
			useLabsStore.setState({ registry: [] });
			useLabsStore.setState({ flags: { sessionSummary: true, telegramChannel: false } as never });
			useAiStatusStore.setState({
				status: { ...AI_ON, runtime: false, killSwitch: true, active: false },
			});
		});
		expect(renders).toBe(settled);
		expect(h.current.value).toBe(true);
		await h.unmount();
	});

	test("TC-7.35c the labs flags unloaded with the AI status loaded is pending, not available (isEnabled would say yes)", async () => {
		setLabs(null);
		setAi(AI_ON, "loaded");
		expect(useLabsStore.getState().isEnabled("aiSettingsPanel")).toBe(true);
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toEqual({ available: false, state: "pending", reason: null });
		await h.unmount();
	});

	test("TC-7.35d a labs load that failed with no flags is unavailable, and one still loading is pending", async () => {
		setAi(AI_ON, "loaded");
		setLabs(null, "boom", false);
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toEqual({
			available: false,
			state: "unavailable",
			reason: "load_failed",
		});
		await act(async () => setLabs(null, "boom", true));
		expect(h.current.value).toEqual({ available: false, state: "pending", reason: null });
		await h.unmount();
	});

	test("TC-7.35e an AI status load that failed with no status is unavailable, and one still loading is pending", async () => {
		setLabs({ sessionSummary: true });
		setAi(null, "error");
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toEqual({
			available: false,
			state: "unavailable",
			reason: "load_failed",
		});
		await act(async () => setAi(null, "loading"));
		expect(h.current.value).toEqual({ available: false, state: "pending", reason: null });
		await h.unmount();
	});

	test("TC-7.35f the flag off, or missing from the flags, is unavailable with the flag as the reason; a held status survives a later error", async () => {
		setAi(AI_ON, "loaded");
		setLabs({ sessionSummary: false });
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toEqual({
			available: false,
			state: "unavailable",
			reason: "flag_off",
		});
		await act(async () => setLabs({ telegramChannel: true }));
		expect(h.current.value).toMatchObject({ state: "unavailable", reason: "flag_off" });
		await act(async () => setLabs({ sessionSummary: true }));
		expect(h.current.value).toMatchObject({ state: "available" });
		await act(async () => useAiStatusStore.setState({ error: "blip" }));
		expect(h.current.value).toMatchObject({ state: "available" });
		await h.unmount();
	});

	test("TC-7.24c reload asks again only for what failed, and the tab appears once both answer", async () => {
		setLabs(null, "boom", false);
		setAi(null, "error");
		const h = probe();
		await h.render(undefined);
		expect(h.current.value).toMatchObject({ state: "unavailable", reason: "load_failed" });
		await act(async () => {
			await reloadSummaryAvailability();
		});
		expect(labsCalls).toBe(1);
		expect(aiCalls).toBe(1);
		expect(h.current.value).toEqual({ available: true, state: "available", reason: null });
		await act(async () => {
			await reloadSummaryAvailability();
		});
		expect(labsCalls).toBe(1);
		expect(aiCalls).toBe(1);
		await h.unmount();
	});

	test("TC-7.24d a reload that fails again leaves it unavailable and does not throw", async () => {
		setLabs(null, "boom", false);
		setAi(AI_ON, "loaded");
		client.getLabsFlags = async () => {
			labsCalls++;
			throw new Error("still down");
		};
		const h = probe();
		await h.render(undefined);
		await act(async () => {
			await reloadSummaryAvailability();
		});
		expect(labsCalls).toBe(1);
		expect(h.current.value).toMatchObject({ state: "unavailable", reason: "load_failed" });
		await h.unmount();
	});
});
