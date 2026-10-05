/**
 * AGEN-69 phase 8a: the session page's tab strip. The Summary tab exists only when the feature
 * is available, sits second (after Overview), and is an ordinary keyboard-operable button.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Availability } from "../../lib/session-summary-view.js";
import {
	WorkspaceTabBar,
	type WorkspaceTabBarProps,
	workspaceTabButtonId,
} from "./WorkspaceTabBar.js";

const BASE: WorkspaceTabBarProps = {
	active: "activity",
	onSelect: () => {},
	instructionsLabel: "CLAUDE.md",
	isWorking: false,
	hasLaunch: true,
	aiTabEnabled: true,
	summaryAvailable: true,
	summaryBadge: null,
};
const render = (over: Partial<WorkspaceTabBarProps> = {}) =>
	renderToStaticMarkup(createElement(WorkspaceTabBar, { ...BASE, ...over }));
const labels = (html: string) =>
	[...html.matchAll(/<button[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("WorkspaceTabBar", () => {
	test("Summary is second, after Overview, when the feature is available", () => {
		expect(labels(render())).toEqual([
			"Overview",
			"Summary",
			"Activity",
			"Notes",
			"CLAUDE.md",
			"Launch",
			"AI",
		]);
	});

	test("it is absent when the feature isn't available, and the others keep their order", () => {
		const unavailable: Availability[] = ["pending", "unavailable"];
		for (const availability of unavailable) {
			const html = render({ summaryAvailable: availability === ("available" as Availability) });
			expect(labels(html), availability).toEqual([
				"Overview",
				"Activity",
				"Notes",
				"CLAUDE.md",
				"Launch",
				"AI",
			]);
		}
		expect(
			labels(render({ hasLaunch: false, aiTabEnabled: false, summaryAvailable: false })),
		).toEqual(["Overview", "Activity", "Notes", "CLAUDE.md"]);
	});

	test("every tab is a real button; the active one says so to assistive technology", () => {
		const html = render({ active: "summary" });
		const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
		expect(buttons).toHaveLength(7);
		for (const b of buttons) expect(b).toContain('type="button"');
		expect(buttons.filter((b) => b.includes('aria-current="page"'))).toHaveLength(1);
		expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*>\s*<span>Summary</);
	});

	test("no tab is current while the requested tab is still pending", () => {
		expect(render({ active: null })).not.toContain("aria-current");
	});

	test("the Summary button can be found by id, so focus can move to it", () => {
		expect(workspaceTabButtonId("summary")).toBe("workspace-tab-summary");
		expect(render()).toContain('id="workspace-tab-summary"');
	});

	test("U-9 the badge has its own accessible wording on the button", () => {
		expect(render({ summaryBadge: "Summarizing" })).toMatch(
			/<button[^>]*id="workspace-tab-summary"[^>]*aria-label="Summary, summarizing now"/,
		);
		expect(render({ summaryBadge: "New" })).toContain('aria-label="Summary, new summary ready"');
		expect(render({ summaryBadge: null })).not.toContain("aria-label");
	});

	test("the Summarizing badge shows on the Summary tab, in words", () => {
		expect(render({ summaryBadge: "Summarizing" })).toMatch(
			/Summary<\/span><span[^>]*>Summarizing</,
		);
	});
});
