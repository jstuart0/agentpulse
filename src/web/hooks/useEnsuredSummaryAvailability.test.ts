/**
 * AGEN-69 phase 8b: the dashboard and the Digest only link to the Summary tab. Nothing there loads
 * the AI status, so the link must ask for it itself, or it never appears.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LabsFlags } from "../lib/api.js";
import { api } from "../lib/api.js";
import { resetAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useEnsuredSummaryAvailability } from "./useSummaryAvailable.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };

beforeEach(() => {
	installDomStubs();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null, loading: false, error: null });
	client.getAiStatus = async () => ({
		build: true,
		runtime: true,
		killSwitch: false,
		active: true,
	});
	client.getLabsFlags = async () => ({
		flags: { sessionSummary: true } as unknown as LabsFlags,
		registry: [],
	});
});
afterEach(() => {
	removeDomStubs();
	client.getAiStatus = real.getAiStatus;
	client.getLabsFlags = real.getLabsFlags;
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

describe("useEnsuredSummaryAvailability", () => {
	test("with nothing loaded it loads the flags and the AI status, then says available", async () => {
		const probe = renderHook(() => useEnsuredSummaryAvailability(), undefined);
		await probe.render(undefined);
		expect(probe.current.value).toBe("pending");
		await flush(30);
		expect(probe.current.value).toBe("available");
		await probe.unmount();
	});
});
