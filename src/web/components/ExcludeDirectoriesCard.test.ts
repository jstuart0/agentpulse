/**
 * The Setup page's "Exclude directories" card: its copy buttons carry names, the
 * Claude-direct row is the amber note (words and an icon, a light and a dark
 * text colour), team wording appears only in team mode, and the card has the
 * anchor the first-run link points at.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EXCLUDE_CARD } from "../lib/setup-steps.js";
import { ExcludeDirectoriesCard } from "./ExcludeDirectoriesCard.js";

const render = (showTeamCopy: boolean) =>
	renderToStaticMarkup(createElement(ExcludeDirectoriesCard, { onCopy: () => {}, showTeamCopy }));

describe("ExcludeDirectoriesCard", () => {
	test("heading, anchor and the intro with the rules path in code", () => {
		const html = render(false);
		expect(html).toContain('id="exclude-directories"');
		expect(html).toContain("Exclude directories</h2>");
		expect(html).toContain("<code");
		expect(html).toContain("~/.agentpulse/exclude");
	});

	test("two copy buttons, each with an accessible name that says what it copies", () => {
		const html = render(false);
		const buttons = html.match(/<button[^>]*>/g) ?? [];
		expect(buttons).toHaveLength(2);
		for (const command of EXCLUDE_CARD.commands.map((c) => c.command)) {
			expect(html).toContain(`aria-label="Copy: ${command}"`);
			expect(html).toContain(command);
		}
		for (const b of buttons) expect(b).toContain('type="button"');
	});

	test("one table row per sender, with column headers", () => {
		const html = render(false);
		expect(html).toContain('<th scope="col"');
		expect(html.match(/<th scope="row"/g)).toHaveLength(EXCLUDE_CARD.senders.length);
		for (const row of EXCLUDE_CARD.senders) {
			expect(html).toContain(row.sender);
		}
	});

	test("the Claude-direct row is an amber note: icon hidden from screen readers, light and dark text colours", () => {
		const html = render(false);
		const row = html.match(/<tr[^>]*bg-amber-500\/10[^>]*>[\s\S]*?<\/tr>/);
		expect(row).not.toBeNull();
		expect(row?.[0]).toContain("text-amber-700");
		expect(row?.[0]).toContain("dark:text-amber-300");
		expect(row?.[0]).toContain('aria-hidden="true"');
		expect(row?.[0]).toContain("a broken rules file doesn&#x27;t stop it");
		expect(html.match(/bg-amber-500\/10/g)).toHaveLength(1);
	});

	test("the Windows sentence and the new-events sentence are on the card", () => {
		const html = render(false);
		expect(html).toContain("not yet tested on Windows");
		expect(html).toContain("Rules apply to new events.");
	});

	test("the card clears the sticky header when the first-run link scrolls to it, and its heading can take focus", () => {
		const html = render(false);
		expect(html).toMatch(/<section[^>]*scroll-mt-20/);
		expect(html).toMatch(/<h2 id="exclude-directories-title"[^>]*tabindex="-1"/);
	});

	test("the Setup page moves focus to the card heading after scrolling to it", () => {
		const page = readFileSync(join(import.meta.dir, "..", "pages", "SetupPage.tsx"), "utf8");
		expect(page).toContain("${EXCLUDE_CARD_ANCHOR}-title");
		expect(page).toMatch(/focus\(\{ preventScroll: true \}\)/);
	});

	test("the amber row doesn't say 'Claude Code ... straight to the server' twice, and the skip variable is in code", () => {
		const html = render(false);
		const row = html.match(/<tr[^>]*bg-amber-500\/10[^>]*>[\s\S]*?<\/tr>/)?.[0] ?? "";
		expect(row.match(/straight to the server/g)).toHaveLength(1);
		expect(row).not.toContain("Claude Code posting");
		expect(row).toMatch(/<code[^>]*>AGENTPULSE_SKIP=1<\/code>/);
	});

	test("team wording only in team mode", () => {
		expect(render(true)).toContain("aren&#x27;t visible to admins or other members");
		const solo = render(false);
		expect(solo).not.toMatch(/admin|member|team/i);
	});
});
