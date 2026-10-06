/**
 * AGEN-69 phase 8a (BN-24): a `?tab=summary` link that opened Activity says why, in one line, and
 * offers the way forward that fits the reason.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { LabsFlags } from "../../lib/api.js";
import type { UnavailableReason } from "../../lib/session-summary-view.js";
import { resetAiStatusStore, useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { useUserStore } from "../../stores/user-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { SummaryFellBackNotice } from "./SummaryFellBackNotice.js";

let undoFollow: () => void;
const render = (reason: UnavailableReason | null) =>
	renderToStaticMarkup(
		createElement(
			MemoryRouter,
			null,
			createElement(SummaryFellBackNotice, { reason, onRetry: () => {} }),
		),
	);

beforeEach(() => {
	undoFollow = followLiveState(useLabsStore, useAiStatusStore, useUserStore);
	useAiStatusStore.setState({
		status: { build: true, runtime: true, killSwitch: false, active: true },
		loadState: "loaded",
	});
	useLabsStore.setState({ flags: { sessionSummary: false } as unknown as LabsFlags });
	useUserStore.setState({ mode: "solo", effectiveRole: undefined } as never);
});
afterEach(() => {
	undoFollow();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

describe("SummaryFellBackNotice", () => {
	test("flag off: the line, then the Labs pointer with its Turn on", () => {
		const html = render("flag_off");
		expect(html).toContain("Session summaries are off, so this link opened Activity.");
		expect(html).toContain("Session summaries are a Labs feature and are off.");
		expect(html).toMatch(/<button[^>]*>Turn on<\/button>/);
	});

	test("AI not built in: the line alone, nothing to click", () => {
		const html = render("not_built");
		expect(html).toContain(
			"This server doesn&#x27;t include AI features, so there is no Summary tab.",
		);
		expect(html).not.toContain("<button");
		expect(html).not.toContain("<a ");
	});

	test("the check itself failed: the line and a Retry", () => {
		const html = render("load_failed");
		expect(html).toContain("Couldn&#x27;t check whether summaries are available.");
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>Retry<\/button>/);
	});

	test("no reason, no line", () => {
		expect(render(null)).toBe("");
	});

	test("it is not an alert: the link was present on load", () => {
		for (const reason of ["flag_off", "not_built", "load_failed"] as const) {
			expect(render(reason), reason).not.toContain('role="alert"');
		}
	});
});
