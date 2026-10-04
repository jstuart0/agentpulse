import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { AiStatusResponse } from "../lib/api.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useSummaryAvailability, useSummaryAvailable } from "./useSummaryAvailable.js";

const AI_ON: AiStatusResponse = { build: true, runtime: true, killSwitch: false, active: true };

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

beforeEach(() => {
	installDomStubs();
	setLabs(null);
	setAi(null, "idle");
});
afterEach(() => {
	removeDomStubs();
	setLabs(null);
	setAi(null, "idle");
});

describe("useSummaryAvailable", () => {
	test("TC-7.35a it follows the stores: pending, then available, then unavailable", async () => {
		const h = renderHook(
			() => ({ available: useSummaryAvailable(), state: useSummaryAvailability() }),
			undefined,
		);
		await h.render(undefined);
		expect(h.current.value).toEqual({ available: false, state: "pending" });
		await act(async () => {
			setLabs({ sessionSummary: true });
			setAi(AI_ON, "loaded");
		});
		expect(h.current.value).toEqual({ available: true, state: "available" });
		await act(async () => setAi({ ...AI_ON, build: false }, "loaded"));
		expect(h.current.value).toEqual({ available: false, state: "unavailable" });
		await h.unmount();
	});

	test("TC-7.35b it is a boolean selector: an unrelated store change causes no re-render", async () => {
		setLabs({ sessionSummary: true });
		setAi(AI_ON, "loaded");
		let renders = 0;
		const h = renderHook(() => {
			renders++;
			return useSummaryAvailable();
		}, undefined);
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
});
