/** AGEN-69 BN-20: the heading takes focus when your own generation ends, only if focus is still in the panel. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useHeadingFocus } from "./useHeadingFocus.js";
import type { SummaryAnnouncement } from "./useSessionSummary.js";

beforeEach(() => installDomStubs());
afterEach(() => removeDomStubs());

async function run(announcement: SummaryAnnouncement | null, inside: boolean) {
	let focused = 0;
	const inner = {};
	const p = renderHook(
		(a: SummaryAnnouncement | null) =>
			useHeadingFocus(
				{ current: { contains: (n) => n === inner && inside } },
				{ current: { focus: () => void focused++ } },
				a,
				() => inner,
			),
		announcement,
	);
	await p.render(announcement);
	await p.unmount();
	return focused;
}

describe("useHeadingFocus", () => {
	test("ready or failed with focus inside: focused once", async () => {
		expect(await run("Summary ready", true)).toBe(1);
		expect(await run("Summary failed", true)).toBe(1);
	});
	test("focus elsewhere, still running, or nothing said: not focused", async () => {
		expect(await run("Summary ready", false)).toBe(0);
		expect(await run("Summarizing", true)).toBe(0);
		expect(await run(null, true)).toBe(0);
	});
});
