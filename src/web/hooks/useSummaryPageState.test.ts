/**
 * AGEN-69 phase 8b: the session page's summary wiring as hooks, so it can be tested without
 * rendering the whole page: which tab a URL opens and whether it fell back; the tab's badge and
 * the "New" marker clearing (BN-18).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LabsFlags } from "../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import type { UseSessionSummary } from "./useSessionSummary.js";
import { useSummaryRoute, useSummaryTabBadge } from "./useSummaryPageState.js";

const flags = (on: boolean) => ({ sessionSummary: on }) as unknown as LabsFlags;
function stores(flag: boolean | null, build = true) {
	useLabsStore.setState({ flags: flag === null ? null : flags(flag), loading: false, error: null });
	useAiStatusStore.setState({
		status: { build, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
}
async function route(tab: string | null) {
	const probe = renderHook((t: string | null) => useSummaryRoute(t), tab);
	await probe.render(tab);
	const value = probe.current.value;
	await probe.unmount();
	return value;
}

beforeEach(() => {
	installDomStubs();
	resetAiStatusStore();
});
afterEach(() => {
	removeDomStubs();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

describe("useSummaryRoute", () => {
	test("available: the Summary tab exists and ?tab=summary opens it", async () => {
		stores(true);
		expect(await route("summary")).toEqual({
			workspaceTab: "summary",
			fellBack: null,
			summaryAvailable: true,
		});
		expect((await route(null))?.workspaceTab).toBe("activity");
	});

	test("flag off: no Summary tab, and a summary link opens Activity with the reason", async () => {
		stores(false);
		expect(await route("summary")).toEqual({
			workspaceTab: "activity",
			fellBack: { reason: "flag_off" },
			summaryAvailable: false,
		});
	});

	test("AI not built in is its own reason", async () => {
		stores(true, false);
		expect((await route("summary"))?.fellBack).toEqual({ reason: "not_built" });
	});

	test("while the flags load a summary link waits: no tab chosen, no fall-back line", async () => {
		stores(null);
		expect(await route("summary")).toEqual({
			workspaceTab: null,
			fellBack: null,
			summaryAvailable: false,
		});
	});
});

describe("useSummaryTabBadge", () => {
	function run(
		state: Partial<Pick<UseSessionSummary, "generating" | "newResult">>,
		tab: "summary" | "activity" | null,
	) {
		let cleared = 0;
		const summary = {
			generating: false,
			newResult: false,
			clearNew: () => void cleared++,
			...state,
		};
		const probe = renderHook((t: typeof tab) => useSummaryTabBadge(summary, t), tab);
		return { probe, tab, cleared: () => cleared };
	}

	test("Summarizing while it runs; New for a result seen finishing while on another tab", async () => {
		const a = run({ generating: true }, "activity");
		await a.probe.render("activity");
		expect(a.probe.current.value).toBe("Summarizing");
		const b = run({ newResult: true }, "activity");
		await b.probe.render("activity");
		expect(b.probe.current.value).toBe("New");
		expect(b.cleared()).toBe(0);
		await a.probe.unmount();
		await b.probe.unmount();
	});

	test("BN-18 a result that arrives while the Summary tab is open is cleared at once, not left to show later", async () => {
		const c = run({ newResult: true }, "summary");
		await c.probe.render("summary");
		expect(c.probe.current.value).toBeNull();
		expect(c.cleared()).toBe(1);
		await c.probe.unmount();
	});

	test("nothing when there is nothing to say", async () => {
		const d = run({}, "activity");
		await d.probe.render("activity");
		expect(d.probe.current.value).toBeNull();
		expect(d.cleared()).toBe(0);
		await d.probe.unmount();
	});
});
