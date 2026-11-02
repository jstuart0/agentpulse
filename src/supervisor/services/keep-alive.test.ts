import { describe, expect, test } from "bun:test";
import { countBridgesBounded, keepAliveLine, shouldExitOnStaleHeartbeat } from "./keep-alive.js";

const T = 90_000;

describe("shouldExitOnStaleHeartbeat", () => {
	test("exits only when stale and nothing at all is being looked after", () => {
		expect(
			shouldExitOnStaleHeartbeat({
				staleMs: T + 1,
				thresholdMs: T,
				codex: 0,
				headless: 0,
				bridges: 0,
			}),
		).toBe(true);
	});

	test("a truth table: every combination of stale/fresh and each count 0 or 1", () => {
		for (const stale of [false, true]) {
			for (const codex of [0, 1]) {
				for (const headless of [0, 1]) {
					for (const bridges of [0, 1]) {
						const expected = stale && codex === 0 && headless === 0 && bridges === 0;
						expect(
							shouldExitOnStaleHeartbeat({
								staleMs: stale ? T + 1 : T - 1,
								thresholdMs: T,
								codex,
								headless,
								bridges,
							}),
							`stale=${stale} codex=${codex} headless=${headless} bridges=${bridges}`,
						).toBe(expected);
					}
				}
			}
		}
	});

	test("the threshold itself is not stale: staleMs must be greater", () => {
		const at = (staleMs: number) =>
			shouldExitOnStaleHeartbeat({ staleMs, thresholdMs: T, codex: 0, headless: 0, bridges: 0 });
		expect(at(T - 1)).toBe(false);
		expect(at(T)).toBe(false);
		expect(at(T + 1)).toBe(true);
	});

	test("not knowing how many bridges are alive (an error, no answer) means do not exit", () => {
		expect(
			shouldExitOnStaleHeartbeat({
				staleMs: T * 10,
				thresholdMs: T,
				codex: 0,
				headless: 0,
				bridges: null,
			}),
		).toBe(false);
	});

	test("agents keep it alive however long the server has been gone", () => {
		for (const staleMs of [T + 1, 24 * 3_600_000, 30 * 24 * 3_600_000]) {
			expect(
				shouldExitOnStaleHeartbeat({ staleMs, thresholdMs: T, codex: 1, headless: 0, bridges: 0 }),
			).toBe(false);
			expect(
				shouldExitOnStaleHeartbeat({ staleMs, thresholdMs: T, codex: 0, headless: 2, bridges: 0 }),
			).toBe(false);
			expect(
				shouldExitOnStaleHeartbeat({ staleMs, thresholdMs: T, codex: 0, headless: 0, bridges: 3 }),
			).toBe(false);
		}
	});

	test("queued reports are not an input: they don't keep a supervisor with nothing running alive", () => {
		// the input type has no queue figure at all, so nothing queued can reach the decision
		expect(
			shouldExitOnStaleHeartbeat({
				staleMs: T + 1,
				thresholdMs: T,
				codex: 0,
				headless: 0,
				bridges: 0,
			}),
		).toBe(true);
	});
});

describe("keepAliveLine", () => {
	test("says how long, how many are kept and that their events are queued", () => {
		expect(keepAliveLine(125_400, 3)).toBe(
			"server unreachable for 125s; keeping 3 managed sessions running; their events are queued on this host",
		);
	});
});

describe("countBridgesBounded", () => {
	test("returns the count, and clears its timer", async () => {
		let cancelled = 0;
		const n = await countBridgesBounded(
			async () => 3,
			2_000,
			() => "h",
			() => void cancelled++,
		);
		expect(n).toBe(3);
		expect(cancelled).toBe(1);
	});

	test("an error is null (unknown), not a throw", async () => {
		const n = await countBridgesBounded(
			async () => {
				throw new Error("EACCES");
			},
			2_000,
			() => "h",
			() => {},
		);
		expect(n).toBeNull();
	});

	test("no answer in time is null", async () => {
		let fire: () => void = () => {};
		const pending = countBridgesBounded(
			() => new Promise<number>(() => {}),
			2_000,
			(fn) => {
				fire = fn;
				return "h";
			},
			() => {},
		);
		fire();
		expect(await pending).toBeNull();
	});
});
