/**
 * The Hosts card's one new element: shown only when a host's supervisor reported
 * an invalid exclude file. It says so in words and with an icon (not by colour
 * alone), in colours that carry the card's light and dark themes, and it takes up
 * nothing for every other state.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupervisorRecord } from "../../shared/types.js";
import { HostExcludeNotice } from "./HostExcludeNotice.js";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const render = (
	state: SupervisorRecord["excludeRulesState"] | "none" | "ok",
	over: Partial<Pick<SupervisorRecord, "status" | "heartbeatLeaseExpiresAt">> = {},
) =>
	renderToStaticMarkup(
		createElement(HostExcludeNotice, {
			supervisor: {
				excludeRulesState: state as SupervisorRecord["excludeRulesState"],
				status: "connected",
				heartbeatLeaseExpiresAt: new Date(NOW + 60_000).toISOString(),
				...over,
			},
			now: NOW,
		}),
	);

describe("HostExcludeNotice", () => {
	test("invalid: the sentence, an icon that screen readers skip, in an output element (a polite status)", () => {
		const html = render("invalid");
		expect(html).toContain(
			"This host&#x27;s supervisor is sending nothing: its exclude file or its saved exclude state has an error. Run ",
		);
		// The next step names the command, in code.
		expect(html).toContain("<code");
		expect(html).toContain("agentpulse exclude check</code> on that machine.");
		expect(html).toContain("<svg");
		expect(html).toContain('aria-hidden="true"');
		expect(html.startsWith("<output ")).toBe(true);
	});

	test("it is readable in both themes: a light-mode text colour and a dark: one, never a fixed light-on-light pair", () => {
		const html = render("invalid");
		expect(html).toMatch(/text-amber-700/);
		expect(html).toMatch(/dark:text-amber-300/);
	});

	test("every other state renders nothing at all", () => {
		for (const state of ["none", "ok", null, undefined] as const) {
			expect(render(state), String(state)).toBe("");
		}
	});

	test("a host whose heartbeat lease has expired renders nothing, whatever it last said", () => {
		const expired = new Date(NOW - 1_000).toISOString();
		expect(render("invalid", { heartbeatLeaseExpiresAt: expired })).toBe("");
		expect(render("invalid", { status: "offline" })).toBe("");
		expect(render("invalid", { status: "stale" })).toBe("");
	});

	test("the card carries exactly one notice element, placed once in HostsPage", () => {
		const page = readFileSync(join(import.meta.dir, "..", "pages", "HostsPage.tsx"), "utf-8");
		expect(page.match(/<HostExcludeNotice /g)).toHaveLength(1);
		expect(page).toContain(
			'import { HostExcludeNotice } from "../components/HostExcludeNotice.js";',
		);
		expect(page.toLowerCase()).not.toContain("this machine has stopped");
	});
});
