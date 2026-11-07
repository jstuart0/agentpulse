/**
 * AGEN-117 T12, the host half of the turn guard. A Claude prompt keeps the session's control lock for the
 * whole turn: the host reports `running` when it accepts the prompt and every 30 s after (only to a server
 * that advertises `claude_turn_control`), reports the turn's end until the server answers, and refuses a
 * second Claude process for a session that has one or whose conversation `claude agents` lists.
 *
 * Two layers. The first runs the real handler and the real report gate over spied providers, so timing and
 * report order are exact. The second runs the real prompt provider against a fake `claude` (a shell wrapper
 * around providers/__fixtures__/fake-claude-tree.ts), so the refusals that live in the provider are real.
 * Every real signal goes through a signal guard (D10) that only reaches a pid this test started.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TURN_CONTROL, CLAUDE_TURN_RENEWAL_MS } from "../shared/constants.js";
import {
	CLAUDE_SESSION_OPEN_ERROR,
	CLAUDE_TURN_RUNNING_ERROR,
	STOPPED_BY_PERSON_ERROR,
} from "../shared/managed-messages.js";
import type { ControlAction } from "../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "./control-actions.js";
import {
	disposeAllHeadlessRuntimes,
	headlessRuntimeCount,
	promptClaudeHeadlessSession,
	stopHeadlessClaude,
} from "./providers/claude-headless.js";
import { createFinalReporter } from "./services/final-report.js";
import { createReportGate } from "./services/report-gate.js";
import { SupervisorNetworkError } from "./services/report-resilience.js";
import {
	type SignalGuard,
	createSignalGuard,
	installDescendantKiller,
} from "./test-utils/signal-guard.js";

const SUPERVISOR_ID = "sup-1";
const SESSION = "claude-session-1";

let home: string;
let guard: SignalGuard;
let restoreKiller: () => void;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-claude-turn-")));
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	guard = createSignalGuard();
	restoreKiller = installDescendantKiller(guard);
});
afterEach(async () => {
	await disposeAllHeadlessRuntimes(100, 3000);
	restoreKiller();
	rmSync(home, { recursive: true, force: true });
	expect(guard.refused).toEqual([]);
});

type Posted = { path: string; body: Record<string, unknown> };

function action(
	over: Partial<Record<string, unknown>> = {},
	metadata: Record<string, unknown> = {},
): ControlAction {
	return {
		id: "act-1",
		sessionId: SESSION,
		launchRequestId: "launch-1",
		actionType: "prompt",
		status: "running",
		metadata: {
			prompt: "go",
			agentType: "claude_code",
			cwd: home,
			managedState: "headless",
			launchMode: "headless",
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
			env: {},
			...metadata,
		},
		...over,
	} as unknown as ControlAction;
}

/** A timer the test drives: nothing fires until `tick()`. */
function manualClock() {
	const timers: Array<{ callback: () => void; ms: number; stopped: boolean }> = [];
	return {
		timers,
		schedule: (callback: () => void, ms: number) => {
			const timer = { callback, ms, stopped: false };
			timers.push(timer);
			return {
				stop: () => {
					timer.stopped = true;
				},
			};
		},
		tick: async () => {
			for (const timer of timers) if (!timer.stopped) timer.callback();
			for (let i = 0; i < 20; i++) await Promise.resolve();
		},
		live: () => timers.filter((timer) => !timer.stopped).length,
	};
}

type Turn = { metadata: { executionState: string }; monitor: Promise<void>; pid: number };

function deferredTurn(): { turn: Turn; end: (state?: string) => void; fail: (e: Error) => void } {
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const monitor = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const turn: Turn = { metadata: { executionState: "running" }, monitor, pid: 1 };
	return {
		turn,
		end: (state = "completed") => {
			turn.metadata.executionState = state;
			resolve();
		},
		fail: (e) => reject(e),
	};
}

function harness(
	opts: {
		serverFeatures?: readonly string[];
		reportFailures?: { running?: number; final?: number };
		/** `running` posts after this many are held until `releaseHung()`. */
		hangRunningAfter?: number;
		turn?: ReturnType<typeof deferredTurn>;
		providers?: Partial<ControlProviders>;
		trustedRoots?: string[];
	} = {},
) {
	const posted: Posted[] = [];
	const logged: string[] = [];
	const clock = manualClock();
	const failures = {
		running: opts.reportFailures?.running ?? 0,
		final: opts.reportFailures?.final ?? 0,
	};
	const waits: Array<() => void> = [];
	const attempts = { running: 0 };
	let releaseHung = () => {};
	const hung = new Promise<void>((resolve) => {
		releaseHung = resolve;
	});
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			const body = options?.body ? JSON.parse(String(options.body)) : {};
			if (path.endsWith("/control-actions/act-1/status")) {
				if (body.status === "running") {
					attempts.running++;
					if (opts.hangRunningAfter !== undefined && attempts.running > opts.hangRunningAfter) {
						await hung;
					}
				}
				if (body.status === "running" && failures.running > 0) {
					failures.running--;
					throw new SupervisorNetworkError();
				}
				if (body.status !== "running" && failures.final > 0) {
					failures.final--;
					throw new SupervisorNetworkError();
				}
			}
			posted.push({ path, body });
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	} as never);
	const turn = opts.turn ?? deferredTurn();
	const providers = {
		hasManagedCodexRuntime: () => false,
		hasClaudeStreamRuntime: () => false,
		hasHeadlessRuntime: () => false,
		promptClaudeHeadlessSession: async () => turn.turn,
		stopHeadlessClaude: async () => ({ hadChild: true, gone: true, unchecked: false }),
		...opts.providers,
	} as unknown as ControlProviders;
	const features = opts.serverFeatures ?? [CLAUDE_TURN_CONTROL];
	const handle = createControlActionHandler({
		gate,
		trustedRoots: opts.trustedRoots ?? [home],
		providers,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: home })) as never,
		log: (line: string) => void logged.push(line),
		serverHas: (feature: string) => features.includes(feature),
		schedule: clock.schedule,
		finalReport: createFinalReporter({
			wait: () =>
				new Promise<void>((resolve) => {
					waits.push(resolve);
				}),
			log: () => {},
		}),
	});
	const statuses = () =>
		posted.filter((p) => p.path.endsWith("/control-actions/act-1/status")).map((p) => p.body);
	const settle = async () => {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	};
	return {
		posted,
		logged,
		clock,
		handle,
		turn,
		statuses,
		waits,
		settle,
		attempts,
		releaseHung: () => releaseHung(),
	};
}

describe("renewal: a running prompt keeps its lock", () => {
	test("acceptance reports running at once, then every 30 s, and the turn's end stops the timer", async () => {
		const h = harness();
		await h.handle(action());
		expect(h.statuses().map((s) => s.status)).toEqual(["running"]);
		expect(h.clock.timers.map((t) => t.ms)).toEqual([CLAUDE_TURN_RENEWAL_MS]);
		expect(CLAUDE_TURN_RENEWAL_MS).toBe(30_000);

		await h.clock.tick();
		await h.clock.tick();
		expect(h.statuses().map((s) => s.status)).toEqual(["running", "running", "running"]);

		h.turn.end();
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual([
			"running",
			"running",
			"running",
			"succeeded",
		]);
		expect(h.clock.live()).toBe(0);
		await h.clock.tick();
		expect(h.statuses()).toHaveLength(4);
	});

	test("acceptance comes before the first renewal, and a renewal is only the status (no metadata, no error)", async () => {
		const h = harness();
		await h.handle(action());
		await h.clock.tick();
		const running = h.statuses().filter((s) => s.status === "running");
		expect(running).toHaveLength(2);
		// The first is the host saying it took the prompt on (the server stamps acceptedAt from that and only that);
		// every one after is a renewal, only the status.
		expect(running[0]).toEqual({ status: "running", accepted: true });
		expect(running[1]).toEqual({ status: "running" });
		expect(h.statuses()[0]).toEqual({ status: "running", accepted: true });
	});

	test("a server that doesn't advertise claude_turn_control gets no running reports and no timer", async () => {
		const h = harness({ serverFeatures: [] });
		await h.handle(action());
		await h.clock.tick();
		expect(h.statuses()).toEqual([]);
		expect(h.clock.timers).toEqual([]);
		h.turn.end();
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["succeeded"]);
	});

	test("two renewals can fail and the turn goes on; the third one lands", async () => {
		const h = harness({ reportFailures: { running: 2 } });
		await h.handle(action());
		// The acceptance report itself was the first failure; the first tick is the second.
		await h.clock.tick();
		await h.clock.tick();
		expect(h.statuses().map((s) => s.status)).toEqual(["running"]);
		expect(h.logged.join("\n")).toContain("renew");
		h.turn.end();
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["running", "succeeded"]);
	});

	test("a renewal that hangs isn't stacked on: the next tick waits for it", async () => {
		const h = harness({ hangRunningAfter: 1 });
		await h.handle(action());
		await h.clock.tick();
		await h.clock.tick();
		await h.clock.tick();
		expect(h.attempts.running).toBe(2);
		h.releaseHung();
		await h.settle();
		await h.clock.tick();
		expect(h.attempts.running).toBe(3);
	});
});

describe("the end of a turn is reported until the server answers", () => {
	test("a lost final report is retried after the reconnect; the first attempt returns at once", async () => {
		const h = harness({ reportFailures: { final: 2 } });
		await h.handle(action());
		h.turn.end();
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["running"]);
		expect(h.waits).toHaveLength(1);
		h.waits[0]?.();
		await h.settle();
		expect(h.waits).toHaveLength(2);
		h.waits[1]?.();
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["running", "succeeded"]);
	});

	test("a child that was stopped reports the turn failed in the words a person's Stop uses", async () => {
		const h = harness();
		await h.handle(action());
		h.turn.end("stopped");
		await h.settle();
		const last = h.statuses().at(-1);
		expect(last).toEqual({ status: "failed", error: STOPPED_BY_PERSON_ERROR });
	});

	test("a monitor that rejects reports the turn failed", async () => {
		const h = harness();
		await h.handle(action());
		h.turn.fail(new Error("stream broke"));
		await h.settle();
		expect(h.statuses().at(-1)).toEqual({ status: "failed", error: "stream broke" });
		expect(h.clock.live()).toBe(0);
	});
});

// ── the provider's own refusals, against a fake claude ───────────────────────

const FAKE = join(import.meta.dir, "providers", "__fixtures__", "fake-claude-tree.ts");

function fakeClaudeWorld() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-turn-fake-")));
	mkdirSync(join(dir, "work"), { recursive: true });
	const log = join(dir, "fake.log");
	const wrapper = join(dir, "claude");
	// `claude agents --json` answers from AGENTS_MODE; anything else is the long-lived fake turn.
	writeFileSync(
		wrapper,
		`#!/bin/sh
if [ "$1" = "agents" ]; then
  echo "agents $*" >> "${dir}/agents.log"
  case "$FAKE_AGENTS_MODE" in
    fail) echo "boom" >&2; exit 1 ;;
    listed) echo "[{\\"sessionId\\":\\"$FAKE_AGENTS_ID\\",\\"pid\\":4242}]"; exit 0 ;;
    other) echo '[{"sessionId":"someone-else","pid":1}]'; exit 0 ;;
    *) echo '[]'; exit 0 ;;
  esac
fi
if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi
exec "${process.execPath}" "${FAKE}" "$@"
`,
		{ mode: 0o755 },
	);
	return { dir, work: join(dir, "work"), log, wrapper };
}

function realProviderHarness(world: ReturnType<typeof fakeClaudeWorld>) {
	const saved: Record<string, string | undefined> = {};
	const env: Record<string, string> = {
		HOME: world.dir,
		AGENTPULSE_CLAUDE_COMMAND: world.wrapper,
		AGENTPULSE_SUPERVISOR_DRY_RUN: "false",
		FAKE_CLAUDE_LOG: world.log,
		FAKE_CLAUDE_CHILD: "none",
		FAKE_AGENTS_ID: SESSION,
		FAKE_AGENTS_MODE: "empty",
	};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	const restore = () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const guarded: ControlProviders["promptClaudeHeadlessSession"] = async (...args) => {
		const result = await promptClaudeHeadlessSession(...args);
		guard.allow(result.pid);
		return result;
	};
	const h = harness({
		providers: { promptClaudeHeadlessSession: guarded, stopHeadlessClaude },
		trustedRoots: [world.dir],
	});
	return { ...h, restore };
}

const fakeStarts = (log: string) =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.role === "claude").length
		: 0;

async function until(check: () => boolean, what: string) {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

describe("one Claude process per session (the real prompt provider)", () => {
	test("a second prompt while a turn runs is refused in fixed words and starts no process; after the turn it goes through", async () => {
		const world = fakeClaudeWorld();
		const h = realProviderHarness(world);
		try {
			await h.handle(action({ id: "act-1" }, { cwd: world.work }));
			await until(() => fakeStarts(world.log) === 1, "the first turn to start");
			expect(headlessRuntimeCount()).toBe(1);

			await h.handle(action({ id: "act-2" }, { cwd: world.work }));
			const refused = h.posted
				.filter((p) => p.path.endsWith("/control-actions/act-2/status"))
				.map((p) => p.body);
			expect(refused).toEqual([{ status: "failed", error: CLAUDE_TURN_RUNNING_ERROR }]);
			expect(fakeStarts(world.log)).toBe(1);
			expect(headlessRuntimeCount()).toBe(1);

			// Positive control: the first turn ends, and the same prompt is accepted.
			await h.handle(
				action(
					{ id: "act-3", actionType: "stop" },
					{ runtime: "claude_headless", prompt: undefined },
				),
			);
			await until(() => headlessRuntimeCount() === 0, "the turn to end");
			await h.handle(action({ id: "act-4" }, { cwd: world.work }));
			await until(() => fakeStarts(world.log) === 2, "the second turn to start");
			expect(
				h.posted
					.filter((p) => p.path.endsWith("/control-actions/act-4/status"))
					.map((p) => p.body.status),
			).toEqual(["running"]);
		} finally {
			h.restore();
			rmSync(world.dir, { recursive: true, force: true });
		}
	});

	test("a stopped turn reports its action failed 'Stopped by a person.' and the session stopped", async () => {
		const world = fakeClaudeWorld();
		const h = realProviderHarness(world);
		try {
			await h.handle(action({ id: "act-1" }, { cwd: world.work }));
			await until(() => fakeStarts(world.log) === 1, "the turn to start");
			await h.handle(
				action(
					{ id: "act-stop", actionType: "stop" },
					{ runtime: "claude_headless", prompt: undefined },
				),
			);
			await until(
				() =>
					h.posted.some(
						(p) => p.path.endsWith("/control-actions/act-1/status") && p.body.status === "failed",
					),
				"the stopped turn's report",
			);
			const final = h.posted
				.filter((p) => p.path.endsWith("/control-actions/act-1/status"))
				.map((p) => p.body)
				.at(-1);
			expect(final).toEqual({ status: "failed", error: STOPPED_BY_PERSON_ERROR });
			expect(
				h.posted
					.filter((p) => p.path.endsWith("/managed-session-state"))
					.map((p) => p.body.managedState),
			).toContain("stopped");
		} finally {
			h.restore();
			rmSync(world.dir, { recursive: true, force: true });
		}
	});
});

describe("a headless resume checks `claude agents` for the conversation", () => {
	test("listed: refused in fixed words, nothing started", async () => {
		const world = fakeClaudeWorld();
		const h = realProviderHarness(world);
		process.env.FAKE_AGENTS_MODE = "listed";
		try {
			await h.handle(action({ id: "act-1" }, { cwd: world.work }));
			expect(
				h.posted.filter((p) => p.path.endsWith("/control-actions/act-1/status")).map((p) => p.body),
			).toEqual([{ status: "failed", error: CLAUDE_SESSION_OPEN_ERROR }]);
			expect(fakeStarts(world.log)).toBe(0);
			expect(headlessRuntimeCount()).toBe(0);
		} finally {
			h.restore();
			rmSync(world.dir, { recursive: true, force: true });
		}
	});

	test("another conversation listed: proceeds (positive control for the refusal above)", async () => {
		const world = fakeClaudeWorld();
		const h = realProviderHarness(world);
		process.env.FAKE_AGENTS_MODE = "other";
		try {
			await h.handle(action({ id: "act-1" }, { cwd: world.work }));
			await until(() => fakeStarts(world.log) === 1, "the turn to start");
			expect(existsSync(join(world.dir, "agents.log"))).toBe(true);
		} finally {
			h.restore();
			rmSync(world.dir, { recursive: true, force: true });
		}
	});

	test("the check failing: proceeds, and the host log says it couldn't check", async () => {
		const world = fakeClaudeWorld();
		const lines: string[] = [];
		const warn = console.warn;
		console.warn = (line: unknown) => void lines.push(String(line));
		const h = realProviderHarness(world);
		process.env.FAKE_AGENTS_MODE = "fail";
		try {
			await h.handle(action({ id: "act-1" }, { cwd: world.work }));
			await until(() => fakeStarts(world.log) === 1, "the turn to start");
			expect(lines.join("\n")).toContain("claude_agents_check_failed");
			expect(lines.join("\n")).not.toContain("boom");
		} finally {
			console.warn = warn;
			h.restore();
			rmSync(world.dir, { recursive: true, force: true });
		}
	});
});
