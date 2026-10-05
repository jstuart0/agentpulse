/**
 * AGEN-69 phase 8a: the tab container reads the stores and hands the panel its viewer. BN-28: the
 * viewer carries the REAL `aiPanelAvailable` (the `aiSettingsPanel` Labs flag), not a constant.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
	SUMMARY_VIEW_FIXTURES as F,
	FIXTURE_NOW,
} from "../../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../../shared/session-summary-view.js";
import type { UseSessionSummary } from "../../hooks/useSessionSummary.js";
import { useSummaryViewer } from "../../hooks/useSummaryViewer.js";
import type { LabsFlags } from "../../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { installDomStubs, removeDomStubs, renderHook } from "../../test-utils/render-hook.js";
import { SessionSummaryTab } from "./SessionSummaryTab.js";

let undoFollow: () => void;
const flags = (over: Record<string, boolean>) =>
	({ sessionSummary: true, ...over }) as unknown as LabsFlags;

function summary(
	view: SessionSummaryView,
	over: Partial<UseSessionSummary> = {},
): UseSessionSummary {
	return {
		load: { status: "ready", view },
		lostContact: false,
		generating: view.attempt.status === "generating",
		startedHere: false,
		announcement: null,
		newResult: false,
		refusal: null,
		generate: async () => "started" as const,
		retry: () => {},
		clearNew: () => {},
		...over,
	};
}
const render = (view: SessionSummaryView) =>
	renderToStaticMarkup(
		createElement(
			MemoryRouter,
			null,
			createElement(SessionSummaryTab, {
				sessionId: "s-1",
				agentType: "claude_code",
				summary: summary(view),
			}),
		),
	);

beforeEach(() => {
	undoFollow = followLiveState(useLabsStore, useAiStatusStore, useUserStore);
	resetAiStatusStore();
	useAiStatusStore.setState({
		status: { build: true, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
	useUserStore.setState({ mode: "solo", effectiveRole: undefined } as never);
});
afterEach(() => {
	undoFollow();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
	useUserStore.setState({ mode: "solo", effectiveRole: undefined } as never);
});

describe("SessionSummaryTab", () => {
	test("BN-28 the settings link follows the real aiSettingsPanel flag", () => {
		useLabsStore.setState({ flags: flags({ aiSettingsPanel: true }) });
		expect(render(F.no_provider)).toMatch(/href="\/settings\?panel=ai"[^>]*>Open AI settings</);
		useLabsStore.setState({ flags: flags({ aiSettingsPanel: false }) });
		expect(render(F.no_provider)).toMatch(/href="\/settings"[^>]*>Open Settings</);
	});

	test("it renders the panel from the AI status in the store (paused: the sentence, no button)", () => {
		useLabsStore.setState({ flags: flags({}) });
		useAiStatusStore.setState({
			status: { build: true, runtime: true, killSwitch: true, active: false },
		});
		const html = render(F.ready);
		expect(html).toContain("This summary can&#x27;t be updated while AI is paused.");
		expect(html).not.toContain("<button");
	});

	test("a team member sees the shared note and the member wording", () => {
		useLabsStore.setState({ flags: flags({}) });
		useUserStore.setState({ mode: "team", effectiveRole: "member" } as never);
		expect(render(F.empty)).toContain("Everyone on this instance can read it.");
		expect(render(F.no_provider)).toContain("Ask an admin to add one.");
	});

	test("the generation clock is the viewer's own: a fixed 'now' isn't needed to render", () => {
		useLabsStore.setState({ flags: flags({}) });
		const html = render({
			...F.generating,
			attempt: { ...F.generating.attempt, startedAt: new Date(Date.now() - 65_000).toISOString() },
		});
		expect(html).toMatch(/1:0\d/);
		expect(FIXTURE_NOW).toBeTruthy();
	});
});

describe("useSummaryViewer", () => {
	test("BN-28 aiPanelAvailable is the aiSettingsPanel flag, the ownership flags come from the viewer", async () => {
		installDomStubs();
		try {
			useLabsStore.setState({ flags: flags({ aiSettingsPanel: false }) });
			const probe = renderHook(() => useSummaryViewer(), undefined);
			await probe.render(undefined);
			expect(probe.current.value).toEqual({
				adminSettingsLocked: false,
				showSummarySharedNote: false,
				aiPanelAvailable: false,
			});
			useLabsStore.setState({ flags: flags({ aiSettingsPanel: true }) });
			useUserStore.setState({ mode: "team", effectiveRole: "member" } as never);
			await probe.render(undefined);
			expect(probe.current.value).toEqual({
				adminSettingsLocked: true,
				showSummarySharedNote: true,
				aiPanelAvailable: true,
			});
			await probe.unmount();
		} finally {
			removeDomStubs();
		}
	});
});
