/**
 * AGEN-69 phase 8a: the Labs and AI sections of Settings carry the anchor a `?panel=` link scrolls
 * to, and a focusable heading to land on (the Account section already works this way).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { panelAnchorId } from "../../pages/settings-panels.js";
import { SettingsSection } from "./SettingsSection.js";

const render = (panel: "labs" | "ai", labs = true) =>
	renderToStaticMarkup(
		createElement(
			SettingsSection,
			{ panel, title: panel === "ai" ? "AI watcher" : "Labs", labs, description: "About it." },
			createElement("p", null, "body"),
		),
	);

describe("SettingsSection", () => {
	test("the section carries its panel's anchor id and is labelled by its heading", () => {
		for (const panel of ["labs", "ai"] as const) {
			const html = render(panel);
			expect(html).toContain(`id="${panelAnchorId(panel)}"`);
			expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
			const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
			expect(html).toMatch(new RegExp(`<h2[^>]*id="${labelledBy}"[^>]*tabindex="-1"`));
		}
	});

	test("title, Labs badge, description and content are all there; the badge is optional", () => {
		const html = render("ai");
		expect(html).toContain("AI watcher");
		expect(html).toContain("Labs");
		expect(html).toContain("About it.");
		expect(html).toContain("<p>body</p>");
		expect(render("ai", false)).not.toContain("Experimental");
		expect(render("ai", false)).not.toMatch(/uppercase tracking-wide/);
	});
});
