import { describe, expect, test } from "bun:test";
import type { TimelineMode } from "../components/session-detail/TimelineView.js";
import {
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

	test("TC-7.31h an event the filters can never show is not found, without a fetch", () => {
		expect(plan({ events: [ev(5, "assistant_message", { content: "" })], eventId: 5 })).toEqual({
			action: "not_found",
		});
		expect(plan({ events: [ev(5, "user_ack")], eventId: 5 })).toEqual({ action: "not_found" });
	});
});
