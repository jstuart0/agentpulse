/** AGEN-69 review T-3: the dashboard's session actions and the Digest row carry the Summary link while the feature is available. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { LabsFlags } from "../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { followLiveState } from "../test-utils/live-stores.js";
import { DigestSessionRow } from "./DigestSessionRow.js";
import { SelectedSessionActions } from "./SelectedSessionActions.js";

let undo: () => void;
beforeEach(() => {
	undo = followLiveState(useLabsStore, useAiStatusStore);
	resetAiStatusStore();
	useAiStatusStore.setState({
		status: { build: true, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
});
afterEach(() => {
	undo();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});
const flag = (on: boolean) =>
	useLabsStore.setState({ flags: { sessionSummary: on } as unknown as LabsFlags });
const wrap = (el: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(MemoryRouter, null, el));
const row = {
	sessionId: "s1",
	displayName: "demo",
	status: "active",
	health: "healthy",
	lastActivityAt: "2026-10-04T10:00:00Z",
};

describe("pages that link to the Summary tab", () => {
	test("dashboard actions: Open Summary beside the others when available, absent when not", () => {
		const el = createElement(SelectedSessionActions, { sessionId: "s1", navigate: () => {} });
		flag(true);
		const on = wrap(el);
		expect(on).toContain("Open Workspace");
		expect(on).toContain("Open Activity");
		expect(on).toMatch(/href="\/sessions\/s1\?tab=summary"[^>]*>Open Summary</);
		flag(false);
		expect(wrap(el)).not.toContain("Open Summary");
	});

	test("digest row: a Summary link when available, absent when not", () => {
		const el = createElement(DigestSessionRow, { session: row as never });
		flag(true);
		expect(wrap(el)).toMatch(/href="\/sessions\/s1\?tab=summary"[^>]*>Summary</);
		flag(false);
		expect(wrap(el)).not.toContain("tab=summary");
	});
});
