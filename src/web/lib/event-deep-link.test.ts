import { describe, expect, test } from "bun:test";
import { type TimelineMode, getVisibleEvents } from "../components/session-detail/TimelineView.js";
import {
	EVENT_NOT_FOUND_COPY,
	EVENT_NOT_SHOWN_COPY,
	type RevealFilters,
	type RevealInput,
	emptyRevealGuard,
	evidenceEventId,
	evidenceHref,
	markContextFetched,
	planEventReveal,
} from "./event-deep-link.js";

describe("evidenceHref", () => {
	test("TC-7.13a the link shape, with the session id encoded", () => {
		expect(evidenceHref("s1", 12)).toBe("/sessions/s1?tab=activity#event-12");
		expect(evidenceHref("a/b?c#d", 5)).toBe("/sessions/a%2Fb%3Fc%23d?tab=activity#event-5");
	});

	test("TC-7.13b non-integer, negative, zero and unsafe ids give null", () => {
		for (const bad of [
			1.5,
			-3,
			0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 60,
			"abc",
			"12abc",
			"E12x",
			"E-1",
			"",
			"E",
		]) {
			expect(evidenceHref("s1", bad), String(bad)).toBeNull();
		}
	});

	test("TC-7.13c a stored ledger id (E12) and its digits resolve to the event", () => {
		expect(evidenceHref("s1", "E12")).toBe("/sessions/s1?tab=activity#event-12");
		expect(evidenceHref("s1", "12")).toBe("/sessions/s1?tab=activity#event-12");
		expect(evidenceEventId("E12")).toBe(12);
		expect(evidenceEventId("e12")).toBeNull();
		expect(evidenceEventId("12")).toBeNull();
		expect(evidenceEventId("E0")).toBeNull();
	});
});

type Ev = RevealInput["events"][number];
const ev = (id: number, category: Ev["category"], extra: Partial<Ev> = {}): Ev => ({
	id,
	category,
	isNoise: false,
	content: "x",
	...extra,
});
const OFF: RevealFilters = { showTools: false, showNoisyTools: false, showSystem: false };

function plan(over: Partial<RevealInput> & Pick<RevealInput, "events" | "eventId">) {
	return planEventReveal({
		sessionId: "s1",
		eventsLoaded: true,
		mode: "progress" as TimelineMode,
		filters: OFF,
		guard: emptyRevealGuard(),
		...over,
	});
}

describe("planEventReveal", () => {
	test("TC-7.31a nothing is decided before the events have loaded", () => {
		expect(plan({ events: [], eventId: 5, eventsLoaded: false })).toEqual({ action: "wait" });
	});

	test("TC-7.31b a visible event scrolls", () => {
		expect(plan({ events: [ev(5, "prompt")], eventId: 5 })).toEqual({ action: "scroll" });
	});

	test("TC-7.31c loaded but hidden: the minimal filter change, once", () => {
		const tool = ev(5, "tool_event");
		expect(plan({ events: [tool], eventId: 5 })).toEqual({
			action: "reveal",
			filters: { showTools: true },
		});
		const noisy = ev(6, "tool_event", { isNoise: true });
		expect(plan({ events: [noisy], eventId: 6 })).toEqual({
			action: "reveal",
			filters: { showTools: true, showNoisyTools: true },
		});
		expect(plan({ events: [noisy], eventId: 6, filters: { ...OFF, showTools: true } })).toEqual({
			action: "reveal",
			filters: { showNoisyTools: true },
		});
		const sys = ev(7, "system_event");
		expect(plan({ events: [sys], eventId: 7 })).toEqual({
			action: "reveal",
			filters: { showSystem: true },
		});
		expect(plan({ events: [sys], eventId: 7, filters: { ...OFF, showSystem: true } })).toEqual({
			action: "scroll",
		});
	});

	test("TC-7.31d debug and terminal modes already show tools", () => {
		for (const mode of ["debug", "terminal"] as TimelineMode[]) {
			expect(plan({ events: [ev(5, "tool_event")], eventId: 5, mode })).toEqual({
				action: "scroll",
			});
		}
	});

	test("TC-7.31e absent and not fetched fetches; after the fetch it is not found and never fetches again", () => {
		const events = [ev(1, "prompt")];
		expect(plan({ events, eventId: 99 })).toEqual({ action: "fetch" });
		const after = markContextFetched(emptyRevealGuard(), "s1", 99);
		for (let i = 0; i < 3; i++)
			expect(plan({ events, eventId: 99, guard: after })).toEqual({ action: "not_found" });
	});

	test("TC-7.31f the guard is per session and event, immutable, and a fresh one starts over", () => {
		const events = [ev(1, "prompt")];
		const guard = markContextFetched(emptyRevealGuard(), "s1", 99);
		expect(plan({ events, eventId: 100, guard })).toEqual({ action: "fetch" });
		expect(plan({ events, eventId: 99, guard, sessionId: "s2" })).toEqual({ action: "fetch" });
		expect(plan({ events, eventId: 99, guard: emptyRevealGuard() })).toEqual({ action: "fetch" });
		expect(emptyRevealGuard().fetched.size).toBe(0);
	});

	test("TC-7.31g the same link clicked twice runs again", () => {
		const events = [ev(5, "tool_event")];
		const first = plan({ events, eventId: 5 });
		const second = plan({ events, eventId: 5 });
		expect(second).toEqual(first);
		expect(plan({ events: [ev(5, "prompt")], eventId: 5 })).toEqual(
			plan({ events: [ev(5, "prompt")], eventId: 5 }),
		);
	});

	test("TC-7.31h an event no mode can show is recorded but not shown, without a fetch, and never reads as missing", () => {
		expect(plan({ events: [ev(5, "assistant_message", { content: "" })], eventId: 5 })).toEqual({
			action: "not_shown",
		});
		expect(plan({ events: [ev(5, "ai_proposal")], eventId: 5 })).toEqual({ action: "not_shown" });
		expect(plan({ events: [ev(5, "ai_error")], eventId: 5, mode: "debug" })).toEqual({
			action: "not_shown",
		});
	});

	test("TC-7.31i the copy for the two dead ends says which one it is", () => {
		expect(EVENT_NOT_FOUND_COPY).toBe("That event is no longer in this session's activity.");
		expect(EVENT_NOT_SHOWN_COPY).toBe(
			"That event is recorded, but Activity doesn't show this kind.",
		);
		expect(EVENT_NOT_FOUND_COPY).not.toBe(EVENT_NOT_SHOWN_COPY);
	});
});

const ALL_MODES: TimelineMode[] = ["prompts", "conversation", "progress", "terminal", "debug"];
/** Quietest first: the order the plan should prefer when it has to change mode. */
const QUIET_TO_NOISY: TimelineMode[] = ["prompts", "conversation", "progress", "terminal", "debug"];
const SHOWN_CATEGORIES: Ev["category"][] = [
	"prompt",
	"assistant_message",
	"progress_update",
	"plan_update",
	"status_update",
	"tool_event",
	"system_event",
	"permission_event",
	"user_ack",
];

describe("planEventReveal: timeline modes (TC-7.41)", () => {
	test("TC-7.41a agent messages hidden in prompts mode switch to conversation, the quietest mode that shows them", () => {
		expect(plan({ events: [ev(5, "assistant_message")], eventId: 5, mode: "prompts" })).toEqual({
			action: "reveal",
			mode: "conversation",
			filters: {},
		});
	});

	test("TC-7.41b plan, status, progress and permission events switch to progress mode from prompts and from conversation", () => {
		for (const category of [
			"plan_update",
			"status_update",
			"progress_update",
			"permission_event",
		] as Ev["category"][]) {
			for (const mode of ["prompts", "conversation"] as TimelineMode[]) {
				expect(
					plan({ events: [ev(5, category)], eventId: 5, mode }),
					`${category} in ${mode}`,
				).toEqual({
					action: "reveal",
					mode: "progress",
					filters: {},
				});
			}
		}
	});

	test("TC-7.41c a system event hidden by the mode needs the mode and the system filter; with the filter already on, only the mode", () => {
		for (const mode of ["prompts", "conversation"] as TimelineMode[]) {
			expect(plan({ events: [ev(5, "system_event")], eventId: 5, mode })).toEqual({
				action: "reveal",
				mode: "progress",
				filters: { showSystem: true },
			});
		}
		expect(
			plan({
				events: [ev(5, "system_event")],
				eventId: 5,
				mode: "prompts",
				filters: { ...OFF, showSystem: true },
			}),
		).toEqual({ action: "reveal", mode: "progress", filters: {} });
	});

	test("TC-7.41d a tool event stays in the current mode with the filter (tools show in every mode once switched on); a debug-only event switches to debug", () => {
		expect(plan({ events: [ev(5, "tool_event")], eventId: 5, mode: "prompts" })).toEqual({
			action: "reveal",
			filters: { showTools: true },
		});
		expect(
			plan({ events: [ev(5, "tool_event", { isNoise: true })], eventId: 5, mode: "conversation" }),
		).toEqual({ action: "reveal", filters: { showTools: true, showNoisyTools: true } });
		expect(plan({ events: [ev(5, "user_ack")], eventId: 5, mode: "prompts" })).toEqual({
			action: "reveal",
			mode: "debug",
			filters: {},
		});
		expect(plan({ events: [ev(5, "user_ack")], eventId: 5, mode: "terminal" })).toEqual({
			action: "reveal",
			mode: "debug",
			filters: {},
		});
	});

	test("TC-7.41e an event the current mode already shows scrolls, with no mode in the plan", () => {
		expect(plan({ events: [ev(5, "plan_update")], eventId: 5, mode: "progress" })).toEqual({
			action: "scroll",
		});
		expect(plan({ events: [ev(5, "prompt")], eventId: 5, mode: "prompts" })).toEqual({
			action: "scroll",
		});
	});

	test("TC-7.41f applying any plan makes every shown category visible, from every mode", () => {
		for (const category of SHOWN_CATEGORIES) {
			for (const from of ALL_MODES) {
				const target = ev(5, category);
				const result = plan({ events: [target], eventId: 5, mode: from });
				const label = `${category} from ${from}`;
				if (result.action === "scroll") {
					expect(getVisibleEvents([target], from, false, false, false), label).toHaveLength(1);
					continue;
				}
				if (result.action !== "reveal") throw new Error(`${label}: ${result.action}`);
				const mode = result.mode ?? from;
				const on = { ...OFF, ...result.filters };
				const shown = getVisibleEvents(
					[target],
					mode,
					on.showTools || mode === "debug" || mode === "terminal",
					on.showNoisyTools,
					on.showSystem,
				);
				expect(shown, label).toHaveLength(1);
			}
		}
	});

	test("TC-7.41g when the mode must change it is the quietest one that works, and a mode is named only when it changes", () => {
		for (const category of SHOWN_CATEGORIES) {
			for (const from of ALL_MODES) {
				const target = ev(5, category);
				const result = plan({ events: [target], eventId: 5, mode: from });
				if (result.action !== "reveal" || result.mode === undefined) continue;
				const label = `${category} from ${from}`;
				expect(result.mode, label).not.toBe(from);
				const worksIn = (m: TimelineMode) =>
					getVisibleEvents([target], m, m === "debug" || m === "terminal", false, true).length ===
					1;
				const quietest = QUIET_TO_NOISY.find((m) => m !== from && worksIn(m));
				if (!quietest) throw new Error(`${label}: no mode works`);
				expect(result.mode, label).toBe(quietest);
			}
		}
	});

	test("TC-7.41h absent events keep their own outcomes: fetch once, then not found", () => {
		const events = [ev(1, "prompt")];
		expect(plan({ events, eventId: 9, mode: "prompts" })).toEqual({ action: "fetch" });
		const after = markContextFetched(emptyRevealGuard(), "s1", 9);
		expect(plan({ events, eventId: 9, mode: "prompts", guard: after })).toEqual({
			action: "not_found",
		});
	});
});
