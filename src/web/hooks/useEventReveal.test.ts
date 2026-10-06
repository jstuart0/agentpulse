/**
 * AGEN-69 phase 8b (BN-23): following an evidence link into Activity. The hook applies
 * `planEventReveal`: scroll and flash, turn on the filters (or switch the mode) that show the
 * event and say so, fetch the surroundings once, and say when the event is gone or never shown.
 */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import {
	EVENT_LOAD_FAILED_COPY,
	EVENT_NOT_FOUND_COPY,
	EVENT_NOT_SHOWN_COPY,
	emptyRevealGuard,
	modeSwitchedCopy,
	planEventReveal,
} from "../lib/event-deep-link.js";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { type EventRevealInput, useEventReveal } from "./useEventReveal.js";

const NO_FILTERS = { showTools: false, showNoisyTools: false, showSystem: false };
const ev = (id: number, category: string, isNoise = false) =>
	({ id, category, isNoise, content: "x" }) as never;

function setup(over: Partial<EventRevealInput> = {}) {
	const calls = {
		flash: [] as number[],
		filters: [] as unknown[],
		modes: [] as string[],
		fetched: [] as number[],
		announced: [] as string[],
	};
	const input: EventRevealInput = {
		sessionId: "s1",
		tab: "activity",
		eventId: 7,
		events: [ev(7, "prompt")],
		eventsLoaded: true,
		mode: "progress",
		filters: NO_FILTERS,
		apply: {
			setMode: (m) => void calls.modes.push(m),
			setFilters: (f) => void calls.filters.push(f),
		},
		fetchContext: async (id) => void calls.fetched.push(id),
		flash: (id) => {
			calls.flash.push(id);
			return true;
		},
		announce: (t) => void calls.announced.push(t),
		...over,
	};
	const probe = renderHook((i: EventRevealInput) => useEventReveal(i), input);
	return {
		calls,
		probe,
		async render(next: Partial<EventRevealInput> = {}) {
			await probe.render({ ...input, ...next });
			await flush();
		},
	};
}

async function run(over: Partial<EventRevealInput> = {}) {
	installDomStubs();
	const s = setup(over);
	await s.render();
	return s;
}

describe("useEventReveal", () => {
	test("nothing happens off Activity, without an event id, or before the events have loaded", async () => {
		for (const over of [{ tab: "summary" as const }, { eventId: null }, { eventsLoaded: false }]) {
			const s = await run(over);
			expect(s.calls.flash).toEqual([]);
			expect(s.calls.fetched).toEqual([]);
			expect(s.probe.current.value?.notice).toBeNull();
			await s.probe.unmount();
			removeDomStubs();
		}
	});

	test("an event that is already shown is scrolled to and flashed once, however often the page re-renders", async () => {
		const s = await run();
		await s.render();
		await s.render({ events: [ev(7, "prompt"), ev(8, "prompt")] });
		expect(s.calls.flash).toEqual([7]);
		await s.probe.unmount();
		removeDomStubs();
	});

	test("a hidden event turns on the fewest filters that show it", async () => {
		const s = await run({ events: [ev(7, "tool_event")] });
		expect(s.calls.filters).toEqual([{ showTools: true }]);
		expect(s.calls.modes).toEqual([]);
		expect(s.probe.current.value?.notice).toBeNull();
		await s.probe.unmount();
		removeDomStubs();
	});

	test("an event that needs another mode switches to it, says so, and still turns the filters on", async () => {
		const events = [ev(7, "system_event")];
		const plan = planEventReveal({
			sessionId: "s1",
			eventId: 7,
			events,
			eventsLoaded: true,
			mode: "prompts",
			filters: NO_FILTERS,
			guard: emptyRevealGuard(),
		});
		expect(plan).toMatchObject({ action: "reveal", mode: "progress" });
		const s = await run({ events, mode: "prompts" });
		expect(s.calls.modes).toEqual(["progress"]);
		expect(s.calls.filters).toEqual([{ showSystem: true }]);
		expect(s.probe.current.value?.notice).toBe(modeSwitchedCopy("progress"));
		expect(modeSwitchedCopy("progress")).toBe("Switched Activity to Progress to show this event.");
		await s.probe.unmount();
		removeDomStubs();
	});

	test("an event outside the loaded window is fetched once; if it still isn't there it says so, once, aloud", async () => {
		const s = await run({ events: [ev(1, "prompt")] });
		expect(s.calls.fetched).toEqual([7]);
		await s.render({ events: [ev(1, "prompt")] });
		await s.render({ events: [ev(1, "prompt")] });
		expect(s.calls.fetched).toEqual([7]);
		expect(s.probe.current.value?.notice).toBe(EVENT_NOT_FOUND_COPY);
		expect(s.calls.announced).toEqual([EVENT_NOT_FOUND_COPY]);
		await s.probe.unmount();
		removeDomStubs();
	});

	test("an event the timeline can't show in any mode says so and changes nothing", async () => {
		const events = [ev(7, "bogus_category")];
		const plan = planEventReveal({
			sessionId: "s1",
			eventId: 7,
			events,
			eventsLoaded: true,
			mode: "progress",
			filters: NO_FILTERS,
			guard: emptyRevealGuard(),
		});
		expect(plan.action).toBe("not_shown");
		const s = await run({ events });
		expect(s.probe.current.value?.notice).toBe(EVENT_NOT_SHOWN_COPY);
		expect(s.calls.announced).toEqual([EVENT_NOT_SHOWN_COPY]);
		expect(s.calls.modes).toEqual([]);
		expect(s.calls.filters).toEqual([]);
		await s.probe.unmount();
		removeDomStubs();
	});

	test("leaving Activity clears the notice and the fetch guard: coming back asks again", async () => {
		const s = await run({ events: [ev(1, "prompt")] });
		await s.render({ events: [ev(1, "prompt")] });
		expect(s.probe.current.value?.notice).toBe(EVENT_NOT_FOUND_COPY);
		await s.render({ tab: "summary", events: [ev(1, "prompt")] });
		expect(s.probe.current.value?.notice).toBeNull();
		await s.render({ events: [ev(1, "prompt")] });
		expect(s.calls.fetched).toEqual([7, 7]);
		await s.probe.unmount();
		removeDomStubs();
	});

	test("a different session starts clean", async () => {
		const s = await run({ events: [ev(1, "prompt")] });
		await s.render({ events: [ev(1, "prompt")] });
		await s.render({ sessionId: "s2", events: [ev(1, "prompt")] });
		expect(s.calls.fetched).toEqual([7, 7]);
		await s.probe.unmount();
		removeDomStubs();
	});

	test("T-4 a failed fetch says it couldn't load, offers Try again, and does not call the event deleted", async () => {
		let attempts = 0;
		const s = await run({
			events: [ev(1, "prompt")],
			fetchContext: async () => {
				attempts++;
				throw new Error("network");
			},
		});
		await s.render({
			events: [ev(1, "prompt")],
			fetchContext: async () => {
				attempts++;
				throw new Error("network");
			},
		});
		expect(s.probe.current.value?.notice).toBe(EVENT_LOAD_FAILED_COPY);
		expect(s.probe.current.value?.notice).not.toBe(EVENT_NOT_FOUND_COPY);
		expect(attempts).toBe(1);
		const before = attempts;
		await act(async () => s.probe.current.value?.retry());
		await flush();
		expect(attempts).toBeGreaterThan(before);
		await s.probe.unmount();
		removeDomStubs();
	});
});
