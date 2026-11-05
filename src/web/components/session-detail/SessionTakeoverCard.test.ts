import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { installDomStubs, removeDomStubs } from "../../test-utils/render-hook.js";
import {
	TAKEOVER_SLOT_ID,
	TakeoverCardBody,
	TakeoverDialogDescription,
	TakeoverDialogFields,
	TakeoverProgress,
} from "./SessionTakeoverCard.js";

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const noop = () => {};

describe("TakeoverCardBody", () => {
	test("hidden renders nothing at all", () => {
		expect(html(createElement(TakeoverCardBody, { view: { kind: "hidden" }, onOpen: noop }))).toBe(
			"",
		);
	});

	test("eligible: the sentence, the Take over… button, and a slot that focus can land on", () => {
		const out = html(
			createElement(TakeoverCardBody, {
				view: {
					kind: "eligible",
					text: "Started outside AgentPulse. Once it has ended, a connected machine can take it over so you can send prompts here.",
					failure: null,
					hostsState: "ready",
				},
				onOpen: noop,
			}),
		);
		expect(out).toContain("Started outside AgentPulse.");
		expect(out).toContain("Take over…");
		expect(out).toContain(`id="${TAKEOVER_SLOT_ID}"`);
		expect(out).toContain('tabindex="-1"');
		expect(out).not.toContain('role="alert"');
	});

	test("the button is a 44px target on a phone", () => {
		const out = html(
			createElement(TakeoverCardBody, {
				view: { kind: "eligible", text: "t", failure: null, hostsState: "ready" },
				onOpen: noop,
			}),
		);
		expect(out).toContain("min-h-[44px]");
	});

	test("info states are a sentence with no control", () => {
		const out = html(
			createElement(TakeoverCardBody, {
				view: {
					kind: "info",
					text: "You can take this session over here once it's been quiet for 5 minutes.",
					failure: null,
				},
				onOpen: noop,
			}),
		);
		expect(out).toContain("once it&#x27;s been quiet for 5 minutes.");
		expect(out).not.toContain("<button");
	});

	test("no usable machine in solo links to Hosts; in team it is only a sentence", () => {
		const solo = html(
			createElement(TakeoverCardBody, {
				view: {
					kind: "no_host",
					text: "To send prompts here, this session's machine needs the AgentPulse supervisor running.",
					setupLink: true,
					failure: null,
				},
				onOpen: noop,
			}),
		);
		expect(solo).toContain('href="/hosts"');
		expect(solo).toContain("Set up a host");
		expect(solo).not.toContain("<button");
		const team = html(
			createElement(TakeoverCardBody, {
				view: { kind: "no_host", text: "x", setupLink: false, failure: null },
				onOpen: noop,
			}),
		);
		expect(team).not.toContain("href=");
	});

	test("a failure after the 202 returns the card with the host's words in an alert", () => {
		const reason = "studio can't find this session's history, so it wasn't taken over.";
		const out = html(
			createElement(TakeoverCardBody, {
				view: { kind: "eligible", text: "t", failure: reason, hostsState: "ready" },
				onOpen: noop,
			}),
		);
		expect(out).toMatch(
			/role="alert"[^>]*>(<span>)?[^<]*studio can&#x27;t find this session&#x27;s history/,
		);
		expect(out).toContain("Take over…");
	});

	test("a command in a host's sentence is drawn as code, the rest as plain text, with normal word breaking", () => {
		const out = html(
			createElement(TakeoverCardBody, {
				view: {
					kind: "eligible",
					text: "t",
					failure: "run `codex app-server daemon stop` on studio and try again.",
					hostsState: "ready",
				},
				onOpen: noop,
			}),
		);
		expect(out).toMatch(/<code[^>]*break-normal[^>]*>codex app-server daemon stop<\/code>/);
		expect(out).not.toContain("`");
		expect(out).toContain("text-sm text-red-700");
	});

	test("hosts still loading shows no button; hosts that failed offer a retry", () => {
		const loading = html(
			createElement(TakeoverCardBody, {
				view: { kind: "eligible", text: "t", failure: null, hostsState: "loading" },
				onOpen: noop,
			}),
		);
		expect(loading).not.toContain("Take over…");
		expect(loading).toContain('aria-busy="true"');
		const failed = html(
			createElement(TakeoverCardBody, {
				view: { kind: "eligible", text: "t", failure: null, hostsState: "error" },
				onOpen: noop,
				onRetryHosts: noop,
			}),
		);
		expect(failed).toContain("Couldn&#x27;t load your machines.");
		expect(failed).toContain("Try again");
	});

	test("markup in a failure reason is text, not elements", () => {
		const out = html(
			createElement(TakeoverCardBody, {
				view: {
					kind: "eligible",
					text: "t",
					failure: "<img src=x onerror=alert(1)>",
					hostsState: "ready",
				},
				onOpen: noop,
			}),
		);
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img src=x");
	});
});

describe("TakeoverProgress", () => {
	test("is a polite status with the words, and the slot id", () => {
		const out = html(
			createElement(TakeoverProgress, { text: "Asking studio to take over this session…" }),
		);
		expect(out).toContain("<output");
		expect(out).toContain("Asking studio to take over this session…");
		expect(out).toContain(`id="${TAKEOVER_SLOT_ID}"`);
	});
});

describe("TakeoverDialogFields", () => {
	const options = [
		{ id: "a", name: "a", disabled: false, reason: null, label: "a" },
		{ id: "b", name: "b", disabled: true, reason: "offline" as const, label: "b (offline)" },
	];
	const lines = {
		title: "Take over x?",
		lead: "lead",
		adminNote: null,
		reportedHostNote: "This session didn't report a machine name.",
		directory: "Directory: /work/repo",
		teamNote: null,
		whatHappens: ["Codex will run on that machine."],
	};
	const render = (over: Record<string, unknown> = {}) =>
		html(
			createElement(TakeoverDialogFields, {
				options,
				hostId: "",
				onHost: noop,
				lines,
				...over,
			}),
		);

	test("the machine field has a label, a placeholder option and no preselected host", () => {
		const out = render();
		expect(out).toContain("Machine it ran on");
		expect(out).toContain("Choose a machine");
		expect(out).toContain('<option value="" ');
		expect(out).not.toMatch(/<option value="[^"]+"[^>]*selected/);
		expect(out).toMatch(/<option value=""[^>]*selected/);
	});

	test("a disabled option says why in its label", () => {
		const out = render();
		expect(out).toMatch(/<option value="b" disabled="">b \(offline\)<\/option>/);
		expect(out).toMatch(/<option value="a">a<\/option>/);
	});

	test("the select is 16px on a phone, so iOS doesn't zoom", () => {
		expect(render()).toContain("text-base md:text-sm");
	});

	test("the directory is a read-only mono line, not an input", () => {
		const out = render();
		expect(out).toContain("Directory: /work/repo");
		expect(out).toContain("font-mono");
		expect(out).not.toMatch(/<input/);
	});

	test("the reported-machine note sits under the select and is referenced by it", () => {
		const out = render();
		expect(out).toContain("This session didn&#x27;t report a machine name.");
		expect(out).toMatch(/aria-describedby="[^"]+"/);
	});

	test("the team note appears when there is one", () => {
		const out = render({ lines: { ...lines, teamNote: "check this is your session first." } });
		expect(out).toContain("check this is your session first.");
		expect(render()).not.toContain("check this is your session first.");
	});

	test("long names and directories wrap instead of widening the sheet", () => {
		const out = render();
		expect(out).toMatch(/\[overflow-wrap:anywhere\]|break-all|break-words/);
	});
});

describe("TakeoverDialogDescription", () => {
	const lines = {
		title: "t",
		lead: "Only continue if this session has ended on the machine it ran on.",
		adminNote: "This is Bob's session. It stays theirs, and they'll see that you took it over.",
		reportedHostNote: "x",
		directory: "Directory: /w",
		teamNote: null,
		whatHappens: ["Codex will run on that machine."],
	};
	test("the limits and the lead come first, in the region the dialog is described by", () => {
		const out = html(createElement(TakeoverDialogDescription, { lines }));
		const lead = out.indexOf("Only continue if");
		const admin = out.indexOf("This is Bob");
		const what = out.indexOf("Codex will run on that machine.");
		expect(lead).toBeGreaterThanOrEqual(0);
		expect(admin).toBeGreaterThan(lead);
		expect(what).toBeGreaterThan(admin);
	});
	test("no admin note, no empty paragraph", () => {
		const out = html(
			createElement(TakeoverDialogDescription, { lines: { ...lines, adminNote: null } }),
		);
		expect(out).not.toContain("<p></p>");
	});
});
