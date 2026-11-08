/**
 * The timeline's treatment of events a supervisor replayed late: the time shown is when the event happened
 * (in a <time> element), the "arrived N min later" note goes on the first row of each late run over the rows
 * on screen, rows stay in the order given, and a ManagedEventsLost row is plain text.
 */
import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "../../../shared/types.js";
import { ActivityTimeline, type ForkDetail, rowDetails } from "./ActivityTimeline.js";

const STORED_MS = Date.now();
const STORED = new Date(STORED_MS).toISOString();
/** m minutes before the moment the rows were stored, exactly. */
const minutesAgo = (m: number) => new Date(STORED_MS - m * 60_000).toISOString();

let id = 0;
const event = (over: Partial<SessionEvent>): SessionEvent =>
	({
		id: ++id,
		sessionId: "s1",
		eventType: "ManagedProbe",
		category: "system_event",
		source: "launch_system",
		content: `row-${id}`,
		isNoise: false,
		createdAt: STORED,
		...over,
	}) as SessionEvent;

const render = (visibleEvents: SessionEvent[]) =>
	renderToStaticMarkup(
		createElement(ActivityTimeline, {
			visibleEvents,
			mode: "conversation",
			onScroll: () => {},
			endRef: createRef<HTMLDivElement>(),
		}),
	);

const count = (html: string, text: string) => html.split(text).length - 1;

describe("ActivityTimeline late arrivals", () => {
	test("the time is when it happened, in a <time> element", () => {
		const occurredAt = minutesAgo(30);
		const html = render([event({ occurredAt, content: "replayed" })]);
		expect(html).toContain(`<time dateTime="${occurredAt}" title="Happened `);
		expect(html).toContain("30m ago");
	});

	test("an event with no occurrence time shows when it was stored, with no note", () => {
		const html = render([event({ content: "live" })]);
		expect(html).toContain(`<time dateTime="${STORED}">`);
		expect(html).not.toContain("arrived");
	});

	test("the note goes on the first row of a late run only", () => {
		const late = () => event({ occurredAt: minutesAgo(10) });
		const html = render([event({}), late(), late(), late(), event({}), late()]);
		expect(count(html, "arrived 10m late")).toBe(2);
	});

	test("it is computed over the rows given: take away the on-time row between two runs and they are one", () => {
		const a = event({ occurredAt: minutesAgo(10) });
		const between = event({});
		const b = event({ occurredAt: minutesAgo(10) });
		expect(count(render([a, between, b]), "arrived")).toBe(2);
		expect(count(render([a, b]), "arrived")).toBe(1);
	});

	test("hours and minutes beyond the first hour", () => {
		expect(render([event({ occurredAt: minutesAgo(91) })])).toContain("arrived 1h 31m late");
	});

	test("every late row is marked and says both times, on screen and to a screen reader; only the first of a run carries the note", () => {
		const late = () => event({ occurredAt: minutesAgo(10) });
		const html = render([event({}), late(), late(), event({})]);
		expect(count(html, "border-dashed")).toBe(2);
		expect(count(html, 'title="Happened ')).toBe(2);
		expect(count(html, 'class="sr-only"> Happened ')).toBe(2);
		expect(count(html, "reached AgentPulse")).toBe(4);
		expect(count(html, "arrived 10m late")).toBe(1);
		// the separator before the note is not read out
		expect(html).toContain('<span aria-hidden="true"> · </span>');
	});

	test("the marker is on the bubble's own box, not on a full-width wrapper around it", () => {
		const html = render([
			event({
				occurredAt: minutesAgo(10),
				category: "prompt",
				eventType: "UserPromptSubmit",
				content: "typed",
			}),
		]);
		// the dashed border sits on the right-aligned prompt's 80% box
		expect(html).toContain('class="max-w-[80%] border-l-2 border-dashed');
		expect(html).not.toMatch(/<div id="event-\d+" class="[^"]*border-dashed/);
	});

	test("an on-time row has no marker, no title and no extra text", () => {
		const html = render([event({})]);
		expect(html).not.toContain("border-dashed");
		expect(html).not.toContain("Happened");
	});

	test("the <time> value is ISO even when the stored time is the SQLite form", () => {
		const html = render([event({ createdAt: "2026-11-01 12:00:00" })]);
		expect(html).toContain('dateTime="2026-11-01T12:00:00.000Z"');
	});

	test("rows keep the order they were given, even when occurrence times run backwards", () => {
		const first = event({ occurredAt: minutesAgo(30), content: "first-row" });
		const second = event({ occurredAt: minutesAgo(50), content: "second-row" });
		const html = render([first, second]);
		expect(html.indexOf("first-row")).toBeLessThan(html.indexOf("second-row"));
	});
});

describe("ManagedEventsLost", () => {
	test("its content is text, never Markdown", () => {
		const html = render([
			event({
				eventType: "ManagedEventsLost",
				content: "**3 events** from this session weren't delivered <b>x</b>",
			}),
		]);
		expect(html).toContain("**3 events**");
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(html).not.toContain("<strong>");
		expect(html).not.toContain("<b>x</b>");
	});

	test("the row is amber", () => {
		const html = render([event({ eventType: "ManagedEventsLost", content: "3 events were lost" })]);
		expect(html).toContain("border-amber-500/20");
	});

	test("a loss row that is also late keeps its own amber border: the late mark is on a wrapper, not on the card", () => {
		const html = render([
			event({
				eventType: "ManagedEventsLost",
				content: "3 events were lost",
				occurredAt: minutesAgo(10),
			}),
		]);
		expect(html).toContain("border-amber-500/20");
		const card = html.slice(html.indexOf("rounded-xl"), html.indexOf("rounded-xl") + 120);
		expect(card).toContain("border-amber-500/20");
		expect(card).not.toContain("border-dashed");
		expect(html).toContain('<div class="border-l-2 border-dashed');
	});

	test("another event's content still goes through Markdown", () => {
		const html = render([event({ content: "**bold**" })]);
		expect(html).toContain("<strong>bold</strong>");
	});
});

describe("ActivityTimeline plain-text rows", () => {
	const IMAGE = "![x](https://evil.example/pixel.png)";

	test("a failed-turn row is text whatever category the host gave it (no <img>)", () => {
		for (const category of ["assistant_message", "prompt", "system_event"] as const) {
			const html = render([
				event({ eventType: "HeadlessPromptFailed", category, content: `failed ${IMAGE}` }),
			]);
			expect(html).toContain("failed ![x](https://evil.example/pixel.png)");
			expect(html).not.toContain("<img");
		}
	});

	test("positive control: an ordinary assistant message still renders Markdown", () => {
		const html = render([event({ category: "assistant_message", content: IMAGE })]);
		expect(html).toContain("<img");
	});
});

describe("Details on a continued session's rows (AGEN-123)", () => {
	const TURN_UNASKED =
		"Ran without asking you this turn: Bash (1). Claude treated these as read-only.";
	const detailRow = (kind: string, toolUseId: string | null, content: string, seconds: number) =>
		event({
			eventType: "HeadlessStatus",
			category: "progress_update",
			content,
			createdAt: new Date(STORED_MS + seconds * 1000).toISOString(),
			rawPayload: {
				source: "claude_stream",
				kind,
				...(toolUseId ? { tool_use_id: toolUseId } : {}),
			},
		});
	const marker = (eventType: string, seconds: number) =>
		event({
			eventType,
			category: "system_event",
			content: eventType,
			createdAt: new Date(STORED_MS + seconds * 1000).toISOString(),
		});
	const stored = (toolUseId: string, outcome: string, tool = "Bash") => ({
		toolUseId,
		tool,
		outcome,
		fromSubagent: false,
		input: null,
		inputTruncated: false,
		output: null,
		outputTruncated: false,
		redacted: false,
		createdAt: STORED,
	});

	const events = [
		marker("HeadlessPromptSubmitted", 0),
		detailRow("call", "toolu_a", "Bash: ran without asking", 1),
		detailRow("call", "toolu_b", "Write: ran, you approved it", 2),
		detailRow("call", "toolu_c", "Read: ran without asking", 3),
		detailRow("turn_unasked", null, TURN_UNASKED, 4),
		marker("HeadlessPromptCompleted", 5),
	];
	const detail = (calls: ReturnType<typeof stored>[], working = false): ForkDetail => ({
		context: { sessionId: "s1", access: "allowed", ownerName: null },
		calls: new Map(calls.map((c) => [c.toolUseId, c])),
		allEvents: events,
		working,
	});
	const positions = new Map(events.map((e, i) => [e.id, i]));
	const html = (node: unknown) => renderToStaticMarkup(node as never);

	test("a call row with a stored record gets Details; one without gets nothing", () => {
		const d = detail([stored("toolu_a", "unasked")]);
		const withRecord = rowDetails(events[1] as SessionEvent, d, positions);
		expect(html(withRecord)).toContain('aria-label="Show what Bash ran"');
		expect(rowDetails(events[2] as SessionEvent, d, positions)).toBeNull();
	});

	test("the turn's line gets 'Show what ran' for its unasked calls only, and nothing when none was stored", () => {
		const d = detail([
			stored("toolu_a", "unasked"),
			stored("toolu_b", "approved", "Write"),
			stored("toolu_c", "unasked", "Read"),
		]);
		const row = rowDetails(events[4] as SessionEvent, d, positions);
		expect(html(row)).toContain(">Show what ran<");
		expect(
			rowDetails(
				events[4] as SessionEvent,
				detail([stored("toolu_b", "approved", "Write")]),
				positions,
			),
		).toBeNull();
		expect(rowDetails(events[4] as SessionEvent, detail([]), positions)).toBeNull();
	});

	test("any other row, and a row the page doesn't hold, gets nothing", () => {
		const d = detail([stored("toolu_a", "unasked")]);
		expect(rowDetails(events[0] as SessionEvent, d, positions)).toBeNull();
		expect(rowDetails(events[5] as SessionEvent, d, positions)).toBeNull();
		expect(rowDetails(events[1] as SessionEvent, d, new Map())).toBeNull();
	});

	test("with no session given, the timeline draws no Details control at all", () => {
		const out = render([detailRow("call", "toolu_a", "Bash: ran without asking", 1)]);
		expect(out).not.toContain("Details");
		expect(out).not.toContain("Show what ran");
	});
});
