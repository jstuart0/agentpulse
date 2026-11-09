import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGoneCard } from "./SessionGoneCard.js";

const render = (deleted: boolean) =>
	renderToStaticMarkup(
		createElement(SessionGoneCard, { deleted, onDashboard: () => {}, onSearch: () => {} }),
	);

describe("SessionGoneCard", () => {
	test("a confirmed deletion says so in the heading itself, and says the tab is closed", () => {
		const out = render(true);
		expect(out).toMatch(/<h2[^>]*tabindex="-1"[^>]*>Session deleted<\/h2>/);
		expect(out).toContain("Its tab is closed.");
		expect(out).not.toContain("Session not found");
		expect(out).not.toContain("<output");
		expect(out).not.toContain('role="status"');
	});

	test("a link that led nowhere keeps the hedged wording", () => {
		const out = render(false);
		expect(out).toContain(">Session not found</h2>");
		expect(out).toContain("This session may have been deleted, or the link is incorrect.");
		expect(out).not.toContain("Session deleted");
	});

	test("both offer the way out", () => {
		for (const deleted of [true, false]) {
			const out = render(deleted);
			expect(out).toContain("Back to dashboard");
			expect(out).toContain("Search sessions");
		}
	});
});
