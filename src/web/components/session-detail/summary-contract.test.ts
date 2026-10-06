/**
 * AGEN-69 review T-8: contract rows delivered under their ids.
 * TC-8.4 no HTML injection or markdown renderer anywhere in the panel's import closure.
 * TC-8.5 the Labs badge reads in light and dark. TC-8.9 every animation is motion-safe.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
	SUMMARY_VIEW_FIXTURES as F,
	STORED,
} from "../../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../../shared/session-summary-view.js";
import { LabsBadge } from "../LabsBadge.js";
import { SessionSummaryPanel } from "./SessionSummaryPanel.js";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ENTRY = join(import.meta.dir, "SessionSummaryPanel.tsx");
const FORBIDDEN =
	/dangerouslySetInnerHTML|\.innerHTML\b|MarkdownContent|insertAdjacentHTML|from\s+\"(?:marked|react-markdown|markdown-it|remark[\w-]*)\"/;

/** Reached only for a pure function (`getVisibleEvents`); it renders Activity's markdown, never the summary. */
const NOT_RENDERED_BY_THE_PANEL = ["/src/web/components/session-detail/TimelineView.tsx"];

/** The panel's source files: itself and every relative import under src/web, transitively. */
function importClosure(entry: string): string[] {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file) || NOT_RENDERED_BY_THE_PANEL.some((x) => file.endsWith(x))) return;
		seen.add(file);
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const base = resolve(dirname(file), m[1].replace(/\.js$/, ""));
			const found = [".tsx", ".ts"].map((e) => base + e).find((c) => existsSync(c));
			if (found?.includes("/src/web/")) walk(found);
		}
	};
	walk(entry);
	return [...seen];
}

describe("TC-8.4 the panel's closure never injects HTML", () => {
	test("the closure is big enough to mean something, and none of it uses an injection or a markdown renderer", () => {
		const files = importClosure(ENTRY);
		expect(files.length).toBeGreaterThanOrEqual(8);
		expect(files.some((f) => f.endsWith("SummarySections.tsx"))).toBe(true);
		for (const file of files) {
			if (file.endsWith(".test.ts") || NOT_RENDERED_BY_THE_PANEL.some((x) => file.endsWith(x)))
				continue;
			expect(readFileSync(file, "utf8"), file.replace(ROOT, "")).not.toMatch(FORBIDDEN);
		}
	});

	test("self-test: a planted injection is found by the same scan", () => {
		expect("<p dangerouslySetInnerHTML={{ __html: x }} />").toMatch(FORBIDDEN);
		expect("import MarkdownContent from './x'").toMatch(FORBIDDEN);
		expect('import { marked } from "marked";').toMatch(FORBIDDEN);
	});

	test("hostile text in the model, the provider model and a fact kind is text, never markup", () => {
		const hostile = "<img src=x onerror=alert(1)>";
		const view = {
			...F.ready,
			stored: {
				summary: STORED.summary,
				provenance: {
					...STORED.provenance,
					provider: { kind: "anthropic", model: hostile },
					evidence: {
						...STORED.provenance.evidence,
						E12: { kind: hostile as never, at: "2026-10-04T10:04:00.000Z" },
					},
				},
			},
		} as SessionSummaryView;
		const h = renderToStaticMarkup(
			createElement(
				MemoryRouter,
				null,
				createElement(SessionSummaryPanel, {
					sessionId: "s",
					agentType: "claude_code",
					load: { status: "ready", view },
					lostContact: false,
					refusal: null,
					aiStatus: { build: true, runtime: true, killSwitch: false, active: true },
					viewer: {
						adminSettingsLocked: false,
						showSummarySharedNote: false,
						aiPanelAvailable: true,
					},
					generate: async () => "started" as const,
					retry: () => {},
				}),
			),
		);
		expect(h).not.toContain("<img");
		expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});
});

describe("TC-8.5 the Labs badge text reads in both themes", () => {
	test("a light-theme colour and a dark: one", () => {
		const h = renderToStaticMarkup(createElement(LabsBadge));
		expect(h).toContain("text-amber-800");
		expect(h).toContain("dark:text-amber-300");
		expect(h).not.toMatch(/class="[^"]*(?<!dark:)text-amber-300/);
	});
});

describe("TC-8.9 animation respects reduced motion", () => {
	test("every animate- class in the panel's closure is behind motion-safe:", () => {
		let found = 0;
		for (const file of importClosure(ENTRY)) {
			if (file.endsWith(".test.ts")) continue;
			for (const m of readFileSync(file, "utf8").matchAll(/(\S*)animate-(spin|pulse)/g)) {
				found++;
				expect(m[1], `${file.replace(ROOT, "")}: ${m[0]}`).toMatch(/motion-safe:$/);
			}
		}
		expect(found).toBeGreaterThan(0);
	});
});
