import { describe, expect, test } from "bun:test";
import { startUpdateSync } from "./update-sync.js";

function setup() {
	const calls: string[] = [];
	let interval: (() => void) | null = null;
	let intervalMs = 0;
	let cleared = 0;
	let focus: (() => void) | null = null;
	let wsListener: ((state: string) => void) | null = null;
	let removedFocus = 0;
	let unsubscribed = 0;
	const now = { value: 5_000 };
	const stop = startUpdateSync({
		load: async () => void calls.push("load"),
		refreshIfStale: async (at: number) => void calls.push(`refreshIfStale@${at}`),
		now: () => now.value,
		setInterval: (fn, ms) => {
			interval = fn;
			intervalMs = ms;
			return 1 as never;
		},
		clearInterval: () => void cleared++,
		onFocus: (fn) => {
			focus = fn;
			return () => void removedFocus++;
		},
		onWsState: (fn) => {
			wsListener = fn;
			return () => void unsubscribed++;
		},
	});
	return {
		calls,
		stop,
		now,
		fireInterval: () => interval?.(),
		fireFocus: () => focus?.(),
		ws: (state: string) => wsListener?.(state),
		get intervalMs() {
			return intervalMs;
		},
		get cleared() {
			return cleared;
		},
		get removedFocus() {
			return removedFocus;
		},
		get unsubscribed() {
			return unsubscribed;
		},
	};
}

describe("startUpdateSync", () => {
	test("loads at start and rereads every 6 hours", () => {
		const t = setup();
		expect(t.calls).toEqual(["load"]);
		expect(t.intervalMs).toBe(6 * 3_600_000);
		t.fireInterval();
		expect(t.calls).toEqual(["load", "load"]);
	});

	test("focus asks to refresh only if stale, with the current time", () => {
		const t = setup();
		t.now.value = 9_000;
		t.fireFocus();
		expect(t.calls.at(-1)).toBe("refreshIfStale@9000");
	});

	test("a WebSocket that comes back reloads at once, so a restarted server shows the stale-tab line", () => {
		const t = setup();
		t.ws("connected");
		expect(t.calls).toEqual(["load"]);
		t.ws("reconnecting");
		t.ws("connected");
		expect(t.calls).toEqual(["load", "load"]);
		t.ws("paused");
		t.ws("connected");
		expect(t.calls).toEqual(["load", "load", "load"]);
	});

	test("stop clears the interval and both listeners, and later events do nothing", () => {
		const t = setup();
		t.stop();
		expect([t.cleared, t.removedFocus, t.unsubscribed]).toEqual([1, 1, 1]);
	});
});
