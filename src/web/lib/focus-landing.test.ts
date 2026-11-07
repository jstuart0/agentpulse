import { describe, expect, test } from "bun:test";
import { focusLandingNow, focusLandingWhenReady } from "./focus-landing.js";

function element(name: string, tabIndex = -1, hasTab = false) {
	const calls: string[] = [];
	return {
		name,
		calls,
		tabIndex,
		hasAttribute: () => hasTab,
		setAttribute: (key: string, value: string) => void calls.push(`set ${key}=${value}`),
		focus: () => void calls.push("focus"),
	};
}

function doc(present: Record<string, ReturnType<typeof element>>) {
	return {
		getElementById: (id: string) => present[`#${id}`] ?? null,
		querySelector: (selector: string) => present[selector] ?? null,
	};
}

describe("where focus lands when the Stop dialog's page is gone", () => {
	test("the session header first", () => {
		const header = element("header");
		const heading = element("h1");
		expect(focusLandingNow(doc({ "#session-header": header, "main h1, h1": heading }))).toBe(true);
		expect(header.calls).toEqual(["set tabindex=-1", "focus"]);
		expect(heading.calls).toEqual([]);
	});

	test("then the page heading, then main", () => {
		const heading = element("h1");
		expect(focusLandingNow(doc({ "main h1, h1": heading }))).toBe(true);
		expect(heading.calls).toEqual(["set tabindex=-1", "focus"]);
		const main = element("main");
		expect(focusLandingNow(doc({ main }))).toBe(true);
		expect(main.calls).toContain("focus");
	});

	test("an element that already takes focus is not re-tabindexed; nothing at all is reported", () => {
		const header = element("header", 0, true);
		focusLandingNow(doc({ "#session-header": header }));
		expect(header.calls).toEqual(["focus"]);
		expect(focusLandingNow(doc({}))).toBe(false);
	});
});

describe("waiting for a session that has to be fetched", () => {
	/** A fake page and frame clock: `appearsAtFrame` is the frame the header is rendered on. */
	function page(appearsAtFrame: number | null, withMain = true) {
		let frame = 0;
		const header = element("header");
		const main = element("main");
		const queue: Array<() => void> = [];
		const document = {
			getElementById: (id: string) =>
				id === "session-header" && appearsAtFrame !== null && frame >= appearsAtFrame
					? header
					: null,
			querySelector: (selector: string) => (selector === "main" && withMain ? main : null),
		};
		const run = (frames: number) => {
			for (let i = 0; i < frames && queue.length > 0; i++) {
				frame += 1;
				queue.shift()?.();
			}
		};
		return { document, header, main, schedule: (cb: () => void) => void queue.push(cb), run };
	}

	test("a header that appears a few frames later gets the focus, not main", () => {
		const p = page(4);
		focusLandingWhenReady(p.document, p.schedule, 30);
		p.run(10);
		expect(p.header.calls).toContain("focus");
		expect(p.main.calls).toEqual([]);
	});

	test("a header that is already there is focused on the first frame", () => {
		const p = page(0);
		focusLandingWhenReady(p.document, p.schedule, 30);
		p.run(1);
		expect(p.header.calls).toContain("focus");
	});

	test("a header that never comes: it waits the bounded frames, then settles for main (never nothing)", () => {
		const p = page(null);
		focusLandingWhenReady(p.document, p.schedule, 5);
		p.run(4);
		expect(p.main.calls).toEqual([]);
		p.run(10);
		expect(p.main.calls).toContain("focus");
		expect(p.header.calls).toEqual([]);
	});

	test("it stops scheduling once it has landed, and a cancelled wait does nothing", () => {
		const landed = page(2);
		focusLandingWhenReady(landed.document, landed.schedule, 30);
		landed.run(50);
		expect(landed.header.calls.filter((call) => call === "focus")).toHaveLength(1);

		const cancelled = page(null);
		const cancel = focusLandingWhenReady(cancelled.document, cancelled.schedule, 3);
		cancel();
		cancelled.run(10);
		expect(cancelled.main.calls).toEqual([]);
	});
});
