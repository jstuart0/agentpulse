import { describe, expect, test } from "bun:test";
import {
	countBridgesBounded,
	createStaleClock,
	failureSummary,
	keepAliveLine,
	resumeLine,
	shouldExitOnStaleHeartbeat,
} from "./keep-alive.js";

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

describe("createStaleClock (watchdog across sleep)", () => {
	const TICK = 15_000;
	function setup() {
		let t = 1_000_000;
		const clock = createStaleClock({ now: () => t, tickMs: TICK });
		return {
			clock,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}
	const exits = (staleMs: number) =>
		shouldExitOnStaleHeartbeat({ staleMs, thresholdMs: T, codex: 0, headless: 0, bridges: 0 });

	test("sleeping 15 minutes then waking does not exit on the first tick, and reports the resume once", () => {
		const { clock, advance } = setup();
		advance(TICK);
		clock.tick();
		advance(15 * 60_000);
		const wake = clock.tick();
		expect(wake.resumedAfterMs).toBe(15 * 60_000);
		expect(exits(wake.staleMs)).toBe(false);
		advance(TICK);
		const next = clock.tick();
		expect(next.resumedAfterMs).toBeNull();
		expect(exits(next.staleMs)).toBe(false);
	});

	test("an outage while awake longer than the threshold still exits", () => {
		const { clock, advance } = setup();
		let last = { staleMs: 0, resumedAfterMs: null as number | null };
		for (let i = 0; i < 7; i++) {
			advance(TICK);
			last = clock.tick();
		}
		expect(last.resumedAfterMs).toBeNull();
		expect(last.staleMs).toBe(7 * TICK);
		expect(exits(last.staleMs)).toBe(true);
	});

	test("after a wake, still failing for the full threshold exits", () => {
		const { clock, advance } = setup();
		advance(10 * 60_000);
		clock.tick();
		let last = { staleMs: 0, resumedAfterMs: null as number | null };
		for (let i = 0; i < 7; i++) {
			advance(TICK);
			last = clock.tick();
		}
		expect(last.staleMs).toBe(7 * TICK);
		expect(exits(last.staleMs)).toBe(true);
	});

	test("a heartbeat that succeeds after the wake restarts staleness from that success", () => {
		const { clock, advance } = setup();
		advance(10 * 60_000);
		clock.tick();
		advance(5_000);
		clock.noteHeartbeatOk();
		advance(TICK);
		expect(clock.tick().staleMs).toBe(TICK);
	});

	test("a tick gap just under the margin is not a resume; just over is", () => {
		const a = setup();
		a.advance(25_000);
		expect(a.clock.tick().resumedAfterMs).toBeNull();
		a.advance(29_999);
		expect(a.clock.tick().resumedAfterMs).toBeNull();
		const b = setup();
		b.advance(30_001);
		expect(b.clock.tick().resumedAfterMs).toBe(30_001);
	});

	test("with a short tick the 30 s floor sets the margin", () => {
		let t = 0;
		const clock = createStaleClock({ now: () => t, tickMs: 10_000 });
		t += 25_000;
		expect(clock.tick().resumedAfterMs).toBeNull();
		t += 30_001;
		expect(clock.tick().resumedAfterMs).toBe(30_001);
	});

	test("held runtimes never exit, resumed or not", () => {
		expect(
			shouldExitOnStaleHeartbeat({
				staleMs: 10 * T,
				thresholdMs: T,
				codex: 1,
				headless: 0,
				bridges: 0,
			}),
		).toBe(false);
	});
});

describe("resume and failure lines", () => {
	test("resumeLine matches the documented wording", () => {
		expect(resumeLine(872_400)).toBe("resumed after 872s asleep; heartbeat grace window started");
	});

	test("failureSummary is one line of name and message for a DOMException-shaped error", () => {
		const err = new DOMException("The operation timed out.", "TimeoutError");
		const line = failureSummary(err);
		expect(line).toBe("TimeoutError: The operation timed out.");
		expect(line.includes("\n")).toBe(false);
		expect(failureSummary("boom")).toBe("boom");
	});
});
