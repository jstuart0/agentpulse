/** AGEN-69 phase 8b: "Open Summary" on the dashboard and "Summary" on a Digest row: only while the feature is available. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { LabsFlags } from "../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";
import { followLiveState } from "../test-utils/live-stores.js";
import { SummaryLink } from "./SummaryLink.js";

let undo: () => void;
const render = (variant: "button" | "text", id = "s 1") =>
	renderToStaticMarkup(
		createElement(MemoryRouter, null, createElement(SummaryLink, { sessionId: id, variant })),
	);
function state(flag: boolean | null, build = true) {
	useLabsStore.setState({
		flags: flag === null ? null : ({ sessionSummary: flag } as unknown as LabsFlags),
	});
	useAiStatusStore.setState({
		status: { build, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
}

beforeEach(() => {
	undo = followLiveState(useLabsStore, useAiStatusStore);
	resetAiStatusStore();
});
afterEach(() => {
	undo();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

describe("SummaryLink", () => {
	test("available: a link to the session's Summary tab, worded for where it sits", () => {
		state(true);
		expect(render("button")).toMatch(
			/<a[^>]*href="\/sessions\/s%201\?tab=summary"[^>]*>Open Summary<\/a>/,
		);
		expect(render("text")).toMatch(
			/<a[^>]*href="\/sessions\/s%201\?tab=summary"[^>]*>Summary<\/a>/,
		);
	});

	test("polish: the button does not wrap its own label; the Digest link is muted, not the session-name colour", () => {
		state(true);
		expect(render("button")).toContain("whitespace-nowrap");
		expect(render("text")).toContain("text-muted-foreground");
		expect(render("text")).not.toMatch(/class="[^"]*\btext-primary\b/);
	});

	test("flag off, AI not built in, or still loading: nothing at all", () => {
		state(false);
		expect(render("button")).toBe("");
		state(true, false);
		expect(render("text")).toBe("");
		state(null);
		expect(render("button")).toBe("");
	});
});
