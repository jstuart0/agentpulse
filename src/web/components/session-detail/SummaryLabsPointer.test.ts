/**
 * AGEN-69 phase 8a: the line at the top of the AI tab while Session summaries are off, and the
 * Turn on button behind it. It is above every branch of the AI tab, not inside one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { LabsFlags } from "../../lib/api.js";
import { api } from "../../lib/api.js";
import { labsPointer } from "../../lib/session-summary-view.js";
import { resetAiStatusStore, useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { AiPanel } from "./AiPanel.js";
import {
	SummaryLabsPointer,
	focusSummaryTab,
	turnOnSessionSummaries,
} from "./SummaryLabsPointer.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const realSetLabsFlag = api.setLabsFlag;
let undoFollow: () => void;

const flags = (sessionSummary: boolean) => ({ sessionSummary }) as unknown as LabsFlags;
const withRouter = (child: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(MemoryRouter, null, child));

function setViewer(role: "admin" | "member", mode: "solo" | "team" = "team") {
	useUserStore.setState({ mode, effectiveRole: role } as never);
}

beforeEach(() => {
	undoFollow = followLiveState(useLabsStore, useAiStatusStore, useUserStore);
	resetAiStatusStore();
	useAiStatusStore.setState({
		status: { build: true, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
	useLabsStore.setState({ flags: flags(false), error: null, loading: false });
	setViewer("admin", "solo");
});
afterEach(() => {
	undoFollow();
	client.setLabsFlag = realSetLabsFlag;
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
	useUserStore.setState({ mode: "solo", effectiveRole: undefined } as never);
});

describe("SummaryLabsPointer", () => {
	test("a person who may change Labs gets the sentence, a Turn on button and a quiet 'What it does' link", () => {
		const html = withRouter(createElement(SummaryLabsPointer));
		expect(html).toContain("Session summaries are a Labs feature and are off.");
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>Turn on<\/button>/);
		expect(html).toMatch(/<a[^>]*href="\/settings\?panel=labs"[^>]*>What it does<\/a>/);
	});

	test("a team member is told whom to ask and gets no button", () => {
		setViewer("member");
		const html = withRouter(createElement(SummaryLabsPointer));
		expect(html).toContain("Ask an admin to turn on Session summary in Settings → Labs.");
		expect(html).not.toContain("<button");
		expect(html).not.toContain("<a ");
	});

	test("nothing shows before the flags load, once the flag is on, or when AI isn't built in", () => {
		useLabsStore.setState({ flags: null });
		expect(withRouter(createElement(SummaryLabsPointer))).toBe("");
		useLabsStore.setState({ flags: flags(true) });
		expect(withRouter(createElement(SummaryLabsPointer))).toBe("");
		useLabsStore.setState({ flags: flags(false) });
		useAiStatusStore.setState({
			status: { build: false, runtime: false, killSwitch: false, active: false },
		});
		expect(withRouter(createElement(SummaryLabsPointer))).toBe("");
	});

	test("labsPointer is hidden for an empty flag map, whoever is looking", () => {
		const admin = { adminSettingsLocked: false };
		expect(labsPointer({}, admin)).toEqual({ visible: false });
	});
});

describe("AiPanel carries the pointer above its own content", () => {
	test("the pointer comes first, then the tab's own content (here still loading)", () => {
		const html = withRouter(createElement(AiPanel, { sessionId: "s-1", sessionIsManaged: false }));
		const pointerAt = html.indexOf("Session summaries are a Labs feature");
		const bodyAt = html.indexOf("Loading watcher");
		expect(pointerAt).toBeGreaterThanOrEqual(0);
		expect(bodyAt).toBeGreaterThan(pointerAt);
	});

	test("with the flag on there is no pointer and the tab is unchanged", () => {
		useLabsStore.setState({ flags: flags(true) });
		const html = withRouter(createElement(AiPanel, { sessionId: "s-1", sessionIsManaged: false }));
		expect(html).not.toContain("Labs feature");
		expect(html).toContain("Loading watcher");
	});
});

describe("Turn on", () => {
	test("it sets the flag through the store, reports success, and the flag is then on", async () => {
		const sent: Array<[string, boolean]> = [];
		client.setLabsFlag = async (flag: string, enabled: boolean) => {
			sent.push([flag, enabled]);
			return { flags: { sessionSummary: true } };
		};
		expect(await turnOnSessionSummaries()).toBe(true);
		expect(sent).toEqual([["sessionSummary", true]]);
		expect(
			(useLabsStore.getState().flags as unknown as Record<string, boolean>).sessionSummary,
		).toBe(true);
	});

	test("a refusal leaves the flag off and reports failure, so focus doesn't move to a tab that isn't there", async () => {
		client.setLabsFlag = async () => {
			throw new Error("refused");
		};
		expect(await turnOnSessionSummaries()).toBe(false);
		expect(
			(useLabsStore.getState().flags as unknown as Record<string, boolean>).sessionSummary,
		).toBe(false);
	});

	test("BN-20 focus moves to the Summary tab button by its id", () => {
		const focused: string[] = [];
		focusSummaryTab({
			getElementById: (id: string) => ({ focus: () => focused.push(id) }) as unknown as HTMLElement,
		});
		expect(focused).toEqual(["workspace-tab-summary"]);
		expect(() => focusSummaryTab({ getElementById: () => null })).not.toThrow();
	});
});
