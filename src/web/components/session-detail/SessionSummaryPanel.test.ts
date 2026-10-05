/**
 * AGEN-69 phase 8a: the Summary panel's markup, one assertion set per named state. The panel is
 * rendered to static markup from the shared wire fixtures (no DOM library, no network), so each
 * test reads what a person would read. What a state means is decided in `deriveSummaryView`
 * (tested on its own); these tests prove the markup follows it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
	SUMMARY_VIEW_FIXTURES as F,
	FAILED_VIEW_FIXTURES,
	FIXTURE_NOW,
	REFUSAL_BODY_FIXTURES,
	STORED,
} from "../../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../../shared/session-summary-view.js";
import type { StoredSessionSummary } from "../../../shared/session-summary.js";
import type { AiStatusResponse } from "../../lib/api.js";
import {
	type ClockOptions,
	type RefusalCopy,
	type SummaryLoad,
	type SummaryViewer,
	budgetSentence,
	deriveSummaryView,
	failureCopy,
	finePrint,
	refusalCopy,
	staleText,
} from "../../lib/session-summary-view.js";
import { SessionSummaryPanel, type SessionSummaryPanelProps } from "./SessionSummaryPanel.js";

const CLOCK: ClockOptions = { now: new Date(FIXTURE_NOW), timeZone: "UTC", locale: "en-GB" };
const AI_ON: AiStatusResponse = { build: true, runtime: true, killSwitch: false, active: true };
const AI_PAUSED: AiStatusResponse = { ...AI_ON, killSwitch: true, active: false };
const AI_OFF: AiStatusResponse = { ...AI_ON, runtime: false, active: false };
const ADMIN: SummaryViewer = {
	adminSettingsLocked: false,
	showSummarySharedNote: false,
	aiPanelAvailable: true,
};
const MEMBER: SummaryViewer = {
	adminSettingsLocked: true,
	showSummarySharedNote: true,
	aiPanelAvailable: true,
};

type Over = Partial<SessionSummaryPanelProps>;

function html(view: SessionSummaryView | SummaryLoad, over: Over = {}): string {
	const load: SummaryLoad = "status" in view ? view : { status: "ready", view };
	return renderToStaticMarkup(
		createElement(
			MemoryRouter,
			null,
			createElement(SessionSummaryPanel, {
				sessionId: "s-1",
				agentType: "claude_code",
				load,
				lostContact: false,
				refusal: null,
				aiStatus: AI_ON,
				viewer: ADMIN,
				generate: async () => "started" as const,
				retry: () => {},
				clock: CLOCK,
				...over,
			}),
		),
	);
}

const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;
const buttons = (h: string) => count(h, /<button/g);
const textOf = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
const stateOf = (h: string) => /data-summary-state="([^"]*)"/.exec(h)?.[1] ?? null;

const withSummary = (patch: Partial<StoredSessionSummary["summary"]>): SessionSummaryView => ({
	...F.ready,
	stored: { ...STORED, summary: { ...STORED.summary, ...patch } },
});

describe("every state: the heading row and the state tag", () => {
	test("TC-8.3 an h2 'Summary' and the Labs badge are present in every named state", () => {
		for (const [name, view] of Object.entries(F)) {
			const h = html(view);
			expect(h, name).toMatch(/<h2[^>]*>Summary<\/h2>/);
			expect(h, name).toContain("Labs");
		}
		for (const status of ["loading", "error"] as const) {
			const h = html({ status });
			expect(h, status).toMatch(/<h2[^>]*>Summary<\/h2>/);
			expect(h, status).toContain("Labs");
		}
	});

	test("the root is a section labelled by that heading and carries the model's state tag", () => {
		for (const [name, view] of Object.entries(F)) {
			const h = html(view);
			const tag = deriveSummaryView({ status: "ready", view }, AI_ON, ADMIN, CLOCK)?.stateTag;
			expect(tag, name).toBeDefined();
			expect(stateOf(h), name).toBe(tag as string);
		}
		const h = html(F.empty);
		expect(h).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
		const labelledBy = /aria-labelledby="([^"]+)"/.exec(h)?.[1];
		expect(h).toContain(`id="${labelledBy}"`);
	});

	test("the named states resolve to the documented tags", () => {
		expect(stateOf(html(F.empty))).toBe("none/available/none");
		expect(stateOf(html(F.generating))).toBe("none/generating/none");
		expect(stateOf(html(F.ready))).toBe("ready/available/none");
		expect(stateOf(html(F.stale))).toBe("stale/available/none");
		expect(stateOf(html(F.failed))).toBe("none/available/failed-error");
		expect(stateOf(html(F.no_provider))).toBe("none/blocked:no_provider/none");
		expect(stateOf(html({ status: "loading" }))).toBe("loading/none/none");
		expect(stateOf(html({ status: "error" }))).toBe("load_failed/none/none");
	});

	test("nothing is drawn when the feature is unavailable or the AI status isn't known", () => {
		expect(html({ status: "unavailable" })).toBe("");
		expect(html(F.empty, { aiStatus: null })).toContain('aria-busy="true"');
	});
});

describe("empty", () => {
	test("one primary action: a filled 'Summarize this session', with the consent fine print as its description", () => {
		const h = html(F.empty);
		expect(buttons(h)).toBe(1);
		expect(h).toMatch(/<button[^>]*bg-primary[^>]*>Summarize this session<\/button>/);
		const print = finePrint(F.empty, ADMIN) as string;
		expect(textOf(h)).toContain(print);
		expect(print).toContain("anthropic · claude-sonnet-4-6");
		expect(print).toContain("Up to $0.04, or $0.08");
		const describedBy = /<button[^>]*aria-describedby="([^"]+)"/.exec(h)?.[1];
		expect(describedBy).toBeTruthy();
		expect(h).toMatch(new RegExp(`<div[^>]*id="${describedBy}"`));
	});

	test("phase 8b: the fine print is three short lines (what is sent, what is masked, cost), not one block", () => {
		const lines = [...html(F.empty).matchAll(/<p[^>]*data-fine-print-line[^>]*>([^<]*)<\/p>/g)].map(
			(m) => m[1],
		);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toStartWith("Sends this session&#x27;s prompts");
		expect(lines[1]).toContain("Known secret patterns are masked first.");
		expect(lines[2]).toStartWith("Up to $0.04");
	});

	test("a team member's fine print says who can read it; a free provider says no cost is recorded", () => {
		expect(textOf(html(F.empty, { viewer: MEMBER }))).toContain(
			"Everyone on this instance can read it.",
		);
		expect(textOf(html(F.free_cost))).not.toContain("Up to $");
		expect(textOf(html({ ...F.empty, spend: F.free_cost.spend }))).toContain(
			"No cost is recorded for this provider.",
		);
	});
});

describe("blocked: the reason sits where the button would be, and there is no button", () => {
	test("no provider names it and links to the AI settings section (or Settings when it has none)", () => {
		const h = html(F.no_provider);
		expect(buttons(h)).toBe(0);
		expect(textOf(h)).toContain("No AI provider is set up.");
		expect(h).toMatch(/<a[^>]*href="\/settings\?panel=ai"[^>]*>Open AI settings<\/a>/);
		const plain = html(F.no_provider, { viewer: { ...ADMIN, aiPanelAvailable: false } });
		expect(plain).toMatch(/<a[^>]*href="\/settings"[^>]*>Open Settings<\/a>/);
		const member = html(F.no_provider, { viewer: MEMBER });
		expect(textOf(member)).toContain("No AI provider is set up. Ask an admin to add one.");
		expect(member).not.toContain("<a ");
	});

	test("too little activity, over budget and cooling down say so in words", () => {
		const little = html(F.too_little_activity);
		expect(buttons(little)).toBe(0);
		expect(textOf(little)).toContain("There's nothing to summarize yet.");
		const budget = html(F.spend_cap);
		expect(buttons(budget)).toBe(0);
		expect(textOf(budget)).toContain(budgetSentence(F.spend_cap.spend, CLOCK));
		const cooling = html(F.cooldown);
		expect(buttons(cooling)).toBe(0);
		expect(textOf(cooling)).toContain("You can update again in 17s");
		expect(stateOf(cooling)).toBe("ready/blocked:cooling_down/none");
	});

	test("AI paused or off: a summary stays readable and the sentence replaces Update", () => {
		for (const [ai, sentence] of [
			[AI_PAUSED, "This summary can't be updated while AI is paused."],
			[AI_OFF, "This summary can't be updated while AI is turned off."],
		] as const) {
			const h = html(F.ready, { aiStatus: ai });
			expect(buttons(h), sentence).toBe(0);
			expect(textOf(h)).toContain(sentence);
			expect(textOf(h)).toContain(STORED.summary.overview);
		}
		const none = html(F.empty, { aiStatus: AI_PAUSED });
		expect(textOf(none)).toContain("Summaries can't be made while AI is paused.");
		expect(buttons(none)).toBe(0);
	});

	test("stale and over budget: the notice stays and the over-budget sentence is where Update would be", () => {
		const h = html({ ...F.stale, blocked: "spend_cap_reached" });
		expect(buttons(h)).toBe(0);
		expect(textOf(h)).toContain(staleText(12));
		expect(textOf(h)).toContain("Not enough of today's AI budget left");
	});
});

describe("generating", () => {
	const generating = F.generating;

	test("BN-17 the button stays mounted, aria-disabled and relabelled; never the disabled attribute", () => {
		const h = html(generating);
		expect(buttons(h)).toBe(1);
		const button = /<button[^>]*>/.exec(h)?.[0] as string;
		expect(button).toContain('aria-disabled="true"');
		expect(button).not.toMatch(/\sdisabled(=|\s|>)/);
		expect(h).toMatch(/<button[^>]*>Summarizing…<\/button>/);
		expect(textOf(h)).toContain(
			"Summarizing. This can take a couple of minutes on a long session.",
		);
	});

	test("elapsed time counts from the start and is clamped at zero when the browser clock is behind", () => {
		expect(textOf(html(generating))).toContain("2:00");
		const early = {
			...generating,
			attempt: { ...generating.attempt, startedAt: "2026-10-04T12:00:30.000Z" },
		};
		const h = textOf(html(early));
		expect(h).toContain("0:00");
		expect(h).not.toContain("-");
	});

	test("a previous summary stays on screen at full contrast", () => {
		const view: SessionSummaryView = {
			...F.ready,
			attempt: { status: "generating", startedAt: "2026-10-04T11:58:00.000Z", errorCode: null },
		};
		const h = html(view);
		expect(textOf(h)).toContain(STORED.summary.overview);
		expect(textOf(h)).toContain("Built the summary tab");
		expect(h).not.toMatch(/opacity-\d/);
		expect(stateOf(h)).toBe("ready/generating/none");
	});

	test("BN-22 lost contact while generating: the timer stops and the status line says it may still be finishing", () => {
		const h = html(generating, { lostContact: true });
		const text = textOf(h);
		expect(text).toContain("Lost contact with the server. The summary may still be finishing.");
		expect(text).not.toContain("2:00");
		expect(h).toMatch(/<button[^>]*>Retry<\/button>/);
	});
});

describe("ready", () => {
	test("the ten sections, in the owner's order, as real h3 headings", () => {
		const h = html(F.ready);
		const headings = [...h.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => textOf(m[1]));
		const labels = headings.map((t) => t.split(" · ")[0]);
		expect(labels).toEqual([
			"Overview",
			"Outcome",
			"Accomplishments",
			"Changes",
			"Decisions & Assumptions",
			"Validation",
			"Problems & Risks",
			"Unfinished Work",
			"Recommended Next Actions",
			"Key Context for the Next Agent",
		]);
		expect(headings[2]).toBe("Accomplishments · 2");
		expect(headings[5]).toBe("Validation · 1 passed · 1 unknown");
	});

	test("outcome is a labelled chip plus its sentence", () => {
		const h = html(F.ready);
		expect(h).toMatch(/data-outcome="mostly_completed"[^>]*>Mostly completed</);
		expect(textOf(h)).toContain("Everything but the docs landed.");
	});

	test("a corrected outcome carries the server's sentence", () => {
		const h = textOf(html(F.adjusted));
		expect(h).toContain(
			"The model said Completed. Shown as In progress because the session is still running.",
		);
		expect(h).toContain("A validation step failed (see Validation).");
	});

	test("phase 8b: Update sits beside the 'Generated' text in one row, not floating at the far end", () => {
		const h = html(F.ready);
		expect(h).not.toContain("justify-between");
		expect(h).toMatch(
			/Generated 3 h ago[^<]*<\/p><div[^>]*>(?:(?!<\/div>)[\s\S])*>Update<\/button>/,
		);
	});

	test("nothing is filled in the ready state: one quiet Update, no second action", () => {
		const h = html(F.ready);
		expect(buttons(h)).toBe(1);
		expect(h).toMatch(/<button[^>]*>Update<\/button>/);
		expect(h).not.toContain("bg-primary");
		expect(textOf(h)).toContain("generated 3 h ago");
	});

	test("items show their evidence as links named from stored facts, never ids", () => {
		const h = html(F.ready);
		expect(h).toContain('href="/sessions/s-1?tab=activity#event-12"');
		expect(h).toContain('href="/sessions/s-1?tab=activity#event-13"');
		expect(textOf(h)).toContain("3 edits 10:04");
		expect(textOf(h)).toContain("prompt 10:02");
		expect(h).toContain('aria-label="Open the 3 edits from 10:04 in Activity"');
		expect(textOf(h)).not.toMatch(/\bE1[234]\b/);
		// Exactly the links the stored items cite, and no others: 12 and 13, 12, 14.
		const hrefs = [...h.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
		expect(hrefs).toEqual([
			"/sessions/s-1?tab=activity#event-12",
			"/sessions/s-1?tab=activity#event-13",
			"/sessions/s-1?tab=activity#event-12",
			"/sessions/s-1?tab=activity#event-14",
		]);
		expect(h).toMatch(/<a[^>]*min-h-\[44px\][^>]*md:min-h-0/);
	});

	test("phase 8b: every unverified item carries its own 'Agent's claim only' chip; a backed item (one with links) never does", () => {
		const h = html(F.ready);
		expect(count(textOf(h), /Agent's claim only/g)).toBe(2);
		for (const li of h.match(/<li[\s\S]*?<\/li>/g) ?? []) {
			if (li.includes('href="')) expect(li).not.toContain("Agent&#x27;s claim only");
		}
		expect(h).toMatch(/title="Nothing recorded confirms these[^"]*"[^>]*>Agent&#x27;s claim only</);
	});

	test("phase 8b: no section line says 'nothing recorded' above items whose edits are drawn beneath it", () => {
		expect(textOf(html(F.ready))).not.toContain("Nothing recorded confirms these");
	});

	test("phase 8b: past half the section also says so, and every unverified item keeps its chip; a Codex session gets its extra line", () => {
		const mostly = withSummary({
			accomplishments: [
				{ text: "a", evidence: [], unverified: true },
				{ text: "b", evidence: [], unverified: true },
				{ text: "c", evidence: [], unverified: false },
			],
			changes: [],
		});
		const h = textOf(html(mostly, { agentType: "codex_cli" }));
		expect(h).toContain("Most of these are the agent's claim only.");
		expect(count(h, /Agent's claim only\b/g)).toBe(2);
		expect(h).toContain("Codex often records no result for a command");
		expect(textOf(html(mostly))).not.toContain("Codex often records");
	});

	test("phase 8b: every section opens expanded, so the whole summary reads at a glance", () => {
		for (const name of ["ready", "suspect", "stale", "partial"] as const) {
			const tags = html(F[name]).match(/<details[^>]*>/g) ?? [];
			expect(tags.length, name).toBeGreaterThanOrEqual(8);
			for (const tag of tags) expect(tag, name).toMatch(/\sopen/);
		}
	});

	test("BN-14 validation shows Passed, Failed, Not run and Unknown distinctly; 'completed' is never drawn as passed", () => {
		const view = withSummary({
			validation: [
				{ what: "unit tests", result: "passed", detail: "", evidence: ["E14"], adjusted: false },
				{ what: "lint", result: "failed", detail: "3 errors", evidence: [], adjusted: false },
				{ what: "e2e", result: "not_run", detail: "", evidence: [], adjusted: false },
				{ what: "types", result: "unknown", detail: "", evidence: ["E15"], adjusted: true },
			],
		});
		const withFacts: SessionSummaryView = {
			...view,
			stored: {
				summary: (view.stored as StoredSessionSummary).summary,
				provenance: {
					...STORED.provenance,
					evidence: {
						...STORED.provenance.evidence,
						E15: { kind: "validation", at: "2026-10-04T10:09:00.000Z", result: "completed" },
					},
				},
			},
		};
		const h = html(withFacts);
		const section = /<details[^>]*>(?:(?!<\/details>)[\s\S])*Validation[\s\S]*?<\/details>/.exec(
			h,
		)?.[0] as string;
		const text = textOf(section);
		expect(text).toContain("Validation · 1 passed · 1 failed · 1 unknown · 1 not run");
		expect(text).toMatch(/unit tests[^|]*Passed/);
		expect(text).toMatch(/lint[^|]*Failed/);
		expect(text).toMatch(/e2e[^|]*Not run/);
		expect(text).toMatch(/types[^|]*Unknown: /);
		expect(count(text, /Passed/g)).toBe(1);
		expect(text).toContain("test or build (no result recorded)");
		// Something failed, so the section is open.
		expect(section).toMatch(/^<details[^>]*\sopen/);
	});

	test("a downgraded validation says why in words", () => {
		const h = textOf(html(F.adjusted));
		expect(h).toContain("Unknown: files were edited after this run");
	});

	test("empty sections stay as one muted line instead of vanishing", () => {
		const empty = withSummary({
			accomplishments: [],
			changes: [],
			decisions: [],
			validation: [],
			problems: [],
			unfinished: [],
			nextActions: [],
		});
		const h = html(empty);
		const headings = [...h.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].length;
		expect(headings).toBe(10);
		expect(count(textOf(h), /None recorded\./g)).toBe(6);
		expect(textOf(h)).toContain("No significant unfinished work identified.");
	});

	test("changes are grouped by kind; decisions carry their why; next actions are numbered", () => {
		const h = html(F.ready);
		expect(h).toMatch(/Created[\s\S]*src\/web\/lib\/session-summary-view\.ts/);
		expect(h).toMatch(/Modified[\s\S]*src\/web\/lib\/api\.ts/);
		expect(textOf(h)).toContain("Why: Cheap and responsive");
		expect(h).toMatch(/<ol[\s\S]*Write the docs[\s\S]*Run the live check[\s\S]*<\/ol>/);
	});

	test("Key Context is its own block that keeps line breaks", () => {
		const key = /<details[^>]*>(?:(?!<\/details>)[\s\S])*Key Context[\s\S]*?<\/details>/.exec(
			html(F.ready),
		)?.[0] as string;
		expect(key).toContain("whitespace-pre-wrap");
		expect(key).toContain("break-words");
	});

	test("the footer, the masked count and the retention line", () => {
		const h = textOf(html(F.retention));
		expect(h).toContain("Based on 140 events through 06:41 · claude-sonnet-4-6 · $0.03");
		expect(h).toContain("Removed along with this session's events after 30 days.");
		const masked = withSummary({});
		(masked.stored as StoredSessionSummary).provenance = {
			...STORED.provenance,
			redactionHits: 2,
		};
		expect(textOf(html(masked))).toContain("2 known patterns masked before sending.");
	});

	test("BN-13 the partial-evidence line, in its time form", () => {
		const h = textOf(html(F.partial));
		expect(h).toContain("Based on part of this session: activity before Sat 22:10");
		expect(textOf(html(F.ready))).not.toContain("Based on part of this session");
	});

	test("BN-21 the check-before-pasting notice, by weight, and never an alert", () => {
		const warning = html(F.suspect_warning);
		expect(warning).toContain('data-tone="warning"');
		expect(textOf(warning)).toContain("Check this before pasting it into an agent:");
		expect(textOf(warning)).toContain("It contains text written as instructions to an AI agent.");
		expect(textOf(warning)).toContain(
			"It includes a command that downloads something and runs it.",
		);
		expect(warning).toMatch(/data-tone="warning"[^>]*border-amber/);
		const note = html(F.suspect_note);
		expect(note).toContain('data-tone="note"');
		expect(note).not.toMatch(/data-tone="note"[^>]*border-amber/);
		expect(textOf(note)).toContain("It mentions a web address you didn't type in this session.");
		for (const h of [warning, note]) expect(h).not.toContain('role="alert"');
		expect(html(F.ready)).not.toContain("data-tone=");
	});
});

describe("stale", () => {
	test("BN-17 the notice carries the one filled 'Update summary'; the outcome area has no second Update", () => {
		const h = html(F.stale);
		expect(textOf(h)).toContain(staleText(12));
		expect(buttons(h)).toBe(1);
		expect(h).toMatch(/<button[^>]*bg-primary[^>]*>Update summary<\/button>/);
		expect(h).not.toMatch(/<button[^>]*>Update<\/button>/);
		expect(textOf(h)).toContain(STORED.summary.overview);
	});

	test("the count caps at 100+ and reads in the singular", () => {
		expect(textOf(html(F.stale_capped))).toContain("(100+ prompts and tool calls later)");
		expect(textOf(html(F.stale_one))).toContain("(1 prompt or tool call later)");
	});
});

describe("failures and refusals", () => {
	test("BN-19 every error code's sentence appears in a polite status region, in red when nothing is stored", () => {
		for (const [code, view] of Object.entries(FAILED_VIEW_FIXTURES)) {
			const h = html(view);
			const sentence = failureCopy(code, ADMIN, view.spend.resetsAt, CLOCK);
			expect(textOf(h), code).toContain(sentence);
			expect(h, code).toMatch(/<output[^>]*>[\s\S]*Last attempt, 3 min ago, didn&#x27;t finish:/);
			expect(stateOf(h), code).toBe("none/available/failed-error");
			expect(h, code).not.toContain('role="alert"');
			expect(h, code).toMatch(/text-red-/);
		}
	});

	test("a failure beside a stored summary is muted and keeps the summary", () => {
		const h = html(F.failed_ai_inactive);
		expect(stateOf(h)).toBe("ready/available/failed-muted");
		expect(textOf(h)).toContain(STORED.summary.overview);
		expect(h).not.toMatch(/<output[^>]*text-red-/);
	});

	test("a member sees the member wording for a provider failure", () => {
		const h = html(FAILED_VIEW_FIXTURES.provider_auth, { viewer: MEMBER });
		expect(textOf(h)).toContain("Ask an admin to check the provider.");
	});

	test("every click-time refusal that has text shows it in a status region beside the button", () => {
		let shown = 0;
		for (const [code, { status, body }] of Object.entries(REFUSAL_BODY_FIXTURES)) {
			const copy: RefusalCopy = refusalCopy(
				{ status, code: body.error, retryAfterSeconds: body.retryAfterSeconds ?? null },
				ADMIN,
			);
			const h = html(F.empty, { refusal: copy.text ? copy : null });
			if (copy.text) {
				shown++;
				expect(textOf(h), code).toContain(copy.text);
				expect(h, code).toMatch(/<output[^>]*>[^<]*\S/);
				expect(buttons(h), code).toBe(1);
			} else {
				expect(h, code).toMatch(/<output[^>]*><\/output>/);
			}
		}
		expect(shown).toBeGreaterThan(5);
	});

	test("BN-19 during a rate-limit countdown the button is aria-disabled with its reason visible", () => {
		const copy = refusalCopy({ status: 429, code: "summary_rate_limited", retryAfterSeconds: 4 });
		const h = html(F.empty, { refusal: copy });
		expect(h).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Summarize this session<\/button>/);
		expect(textOf(h)).toContain("Too many summary requests. Try again in 4s.");
	});

	test("a refusal is not shown once the action says something else", () => {
		const copy = refusalCopy({
			status: 409,
			code: "caller_generation_running",
			retryAfterSeconds: null,
		});
		expect(textOf(html(F.generating, { refusal: copy }))).not.toContain(
			"You already have a summary",
		);
		expect(textOf(html(F.no_provider, { refusal: copy }))).not.toContain(
			"You already have a summary",
		);
	});

	test("BN-22 lost contact keeps the summary on screen and offers Retry beside the action", () => {
		const h = html(F.ready, { lostContact: true });
		expect(textOf(h)).toContain("Lost contact with the server.");
		expect(h).toMatch(/<button[^>]*>Retry<\/button>/);
		expect(textOf(h)).toContain(STORED.summary.overview);
		expect(h).toMatch(/<output[^>]*>[\s\S]*Lost contact with the server\./);
	});

	test("load failure and loading", () => {
		const failed = html({ status: "error" });
		expect(textOf(failed)).toContain("Couldn't load the summary.");
		expect(failed).toMatch(/<button[^>]*>Retry<\/button>/);
		expect(buttons(failed)).toBe(1);
		const loading = html({ status: "loading" });
		expect(loading).toContain('aria-busy="true"');
		expect(buttons(loading)).toBe(0);
	});
});

describe("TC-8.11 model text is only ever a React text node", () => {
	const HOSTILE = [
		"<img src=x onerror=alert(1)>",
		"[click](https://evil.example/steal)",
		"javascript:alert(1)",
		"**bold** <script>alert(2)</script> https://auto.example/link",
	].join(" ");

	const hostileView: SessionSummaryView = {
		...F.ready,
		stored: {
			summary: {
				overview: HOSTILE,
				outcome: { status: "mostly_completed", explanation: HOSTILE },
				accomplishments: [{ text: HOSTILE, evidence: ["E12"], unverified: true }],
				changes: [{ kind: "modified", text: HOSTILE, evidence: [], unverified: false }],
				decisions: [{ text: HOSTILE, why: HOSTILE, evidence: [] }],
				validation: [
					{ what: HOSTILE, result: "unknown", detail: HOSTILE, evidence: [], adjusted: false },
				],
				problems: [{ text: HOSTILE, evidence: [] }],
				unfinished: [{ text: HOSTILE, evidence: [] }],
				nextActions: [{ text: HOSTILE, evidence: [] }],
				handoff: HOSTILE,
			},
			provenance: STORED.provenance,
		},
	};

	test("nothing from the model becomes an element, an attribute or a link", () => {
		const h = html(hostileView);
		expect(h).not.toContain("<img");
		expect(h).not.toContain("<script");
		expect(h).not.toMatch(/<[^>]*\sonerror=/);
		expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(h).not.toContain("<strong");
		expect(h).not.toMatch(/href="[^"]*(evil|auto\.example|javascript)/);
		const anchors = [...h.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
		expect(anchors.length).toBeGreaterThan(0);
		for (const href of anchors) expect(href).toMatch(/^\/sessions\/s-1\?tab=activity#event-\d+$/);
		expect(textOf(h)).toContain("[click](https://evil.example/steal)");
	});

	test("the panel sources use no HTML injection and no markdown renderer", () => {
		for (const file of ["SessionSummaryPanel.tsx", "SummarySections.tsx"]) {
			const source = readFileSync(join(import.meta.dir, file), "utf8");
			expect(source, file).not.toContain("dangerouslySetInnerHTML");
			expect(source, file).not.toMatch(/MarkdownContent|react-markdown|marked|innerHTML/);
		}
	});

	test("a long unbroken path wraps instead of widening the page", () => {
		const path = `src/${"very-long-directory-name/".repeat(12)}file.ts`;
		const h = html(
			withSummary({ changes: [{ kind: "created", text: path, evidence: [], unverified: false }] }),
		);
		expect(h).toContain(path);
		expect(h).toMatch(/\[overflow-wrap:anywhere\]/);
	});
});
