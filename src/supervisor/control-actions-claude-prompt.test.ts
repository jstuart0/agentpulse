/**
 * AGEN-117 T16: prompt and stop routing for a takeover fork. A fork's prompt goes to its live process and
 * never to a one-prompt `-p` run; the one-prompt path refuses any id the stream holds or this host's own
 * record lists as a fork; a fork with no process here fails with fixed words and reports `degraded`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TURN_CONTROL, CLAUDE_TURN_RENEWAL_MS } from "../shared/constants.js";
import {
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_NOT_HEADLESS_ERROR,
	CLAUDE_FORK_NO_RUNTIME_ERROR,
	CLAUDE_FORK_RECORD_UNREADABLE_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
	CLAUDE_STREAM_HELD_ERROR,
	NOTHING_RUNNING_STOP_NOTE,
	STOPPED_UNCHECKED_NOTE,
} from "../shared/managed-messages.js";
import type { ControlAction } from "../shared/types.js";
import {
	type ControlProviders,
	STOP_WORDS,
	createControlActionHandler,
} from "./control-actions.js";
import {
	ClaudePromptRefusal,
	ClaudePromptWithheld,
	type TurnOutcome,
	_resetClaudeStreamForTest,
	promptClaudeStreamSession,
} from "./providers/claude-stream.js";
import { createFinalReporter } from "./services/final-report.js";
import { createReportGate } from "./services/report-gate.js";

const SESSION = "22222222-2222-4222-8222-222222222222";
let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-claude-prompt-")));
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => {
	_resetClaudeStreamForTest();
	rmSync(home, { recursive: true, force: true });
});

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
			prompt: "SECRET-PROMPT-TEXT",
			agentType: "claude_code",
			cwd: home,
			managedState: "managed",
			launchMode: "headless",
			runtime: "claude_stream",
			...metadata,
		},
		...over,
	} as unknown as ControlAction;
}

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
		live: () => timers.filter((t) => !t.stopped).length,
	};
}

function deferred() {
	let resolve!: (outcome: TurnOutcome) => void;
	const done = new Promise<TurnOutcome>((r) => {
		resolve = r;
	});
	return { done, end: resolve };
}

function build(
	opts: {
		providers?: Partial<ControlProviders>;
		forkStatus?: (id: string) => "fork" | "not_fork" | "unknown";
		serverFeatures?: readonly string[];
		log?: (line: string) => void;
	} = {},
) {
	const posted: Array<{ path: string; body: Record<string, any> }> = [];
	const spawned = { headless: 0, stream: 0, stop: 0 };
	const clock = manualClock();
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			posted.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: "sup-1",
		home,
		now: () => 0,
		log: () => {},
	} as never);
	const turn = deferred();
	const providers = {
		hasManagedCodexRuntime: () => false,
		hasClaudeStreamRuntime: () => false,
		hasHeadlessRuntime: () => false,
		promptClaudeHeadlessSession: async () => {
			spawned.headless++;
			return { metadata: { executionState: "completed" }, monitor: Promise.resolve(), pid: 1 };
		},
		promptClaudeStreamSession: async () => {
			spawned.stream++;
			return { done: turn.done, metadata: { mode: "claude_stream" } };
		},
		stopClaudeStreamSession: async () => {
			spawned.stop++;
			return { hadChild: true, gone: true, unchecked: false };
		},
		interruptClaudeStreamSession: async () => ({ status: "not_interrupted" as const }),
		stopHeadlessClaude: async () => ({ hadChild: false, gone: true, unchecked: false }),
		...opts.providers,
	} as unknown as ControlProviders;
	const features = opts.serverFeatures ?? [CLAUDE_TURN_CONTROL];
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [home],
		providers,
		forkStatus: opts.forkStatus,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: home })) as never,
		log: opts.log ?? (() => {}),
		serverHas: (f: string) => features.includes(f),
		schedule: clock.schedule,
		finalReport: createFinalReporter({ wait: () => new Promise<void>(() => {}), log: () => {} }),
	});
	const statuses = () =>
		posted.filter((p) => p.path.endsWith("/control-actions/act-1/status")).map((p) => p.body);
	const settle = async () => {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	};
	return { handle, posted, spawned, clock, turn, statuses, settle };
}

describe("a fork's prompt", () => {
	test("goes to the stream provider and spawns no one-prompt process", async () => {
		const h = build();
		await h.handle(action());
		expect(h.spawned).toEqual({ headless: 0, stream: 1, stop: 0 });
	});

	test("is running at acceptance, renewed every 30 s, and succeeds when the turn ends", async () => {
		const h = build();
		await h.handle(action());
		expect(h.statuses().map((s) => s.status)).toEqual(["running"]);
		expect(h.clock.timers.map((t) => t.ms)).toEqual([CLAUDE_TURN_RENEWAL_MS]);
		await h.clock.tick();
		expect(h.statuses().map((s) => s.status)).toEqual(["running", "running"]);
		h.turn.end({ ok: true });
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["running", "running", "succeeded"]);
		expect(h.clock.live()).toBe(0);
	});

	test("to a server without claude_turn_control sends no renewals, only the end", async () => {
		const h = build({ serverFeatures: [] });
		await h.handle(action());
		h.turn.end({ ok: true });
		await h.settle();
		expect(h.statuses().map((s) => s.status)).toEqual(["succeeded"]);
	});

	test("a turn that fails reports failed with the turn's words and replaces the stored metadata", async () => {
		const h = build();
		await h.handle(action());
		h.turn.end({ ok: false, code: "api_error", error: "Fixed words." });
		await h.settle();
		const last = h.statuses().at(-1);
		expect(last).toMatchObject({
			status: "failed",
			error: "Fixed words.",
			metadata: { mode: "claude_stream" },
		});
		expect(JSON.stringify(h.posted)).not.toContain("SECRET-PROMPT-TEXT");
	});

	test("a refusal fails the action with its fixed words, and the prompt text is not echoed", async () => {
		for (const words of [
			CLAUDE_FORK_BUSY_ERROR,
			CLAUDE_FORK_SLASH_MESSAGE,
			CLAUDE_FORK_NO_RUNTIME_ERROR,
		]) {
			const h = build({
				providers: {
					promptClaudeStreamSession: async () => {
						throw new ClaudePromptRefusal("busy", words);
					},
				} as never,
			});
			await h.handle(action());
			expect(h.statuses().at(-1)).toMatchObject({
				status: "failed",
				error: words,
				metadata: { mode: "claude_stream" },
			});
			expect(h.clock.timers).toHaveLength(0);
			expect(JSON.stringify(h.posted)).not.toContain("SECRET-PROMPT-TEXT");
		}
	});

	test("one the gate withheld is refused, not failed", async () => {
		const h = build({
			providers: {
				promptClaudeStreamSession: async () => {
					throw new ClaudePromptWithheld();
				},
			} as never,
		});
		await h.handle(action());
		expect(
			h.posted.some(
				(p) => p.path.endsWith("/control-actions/act-1/status") && p.body.status === "failed",
			),
		).toBe(true);
		expect(h.statuses().every((s) => s.status !== "succeeded")).toBe(true);
	});

	test("with no process on this host the real provider reports degraded once, fails the prompt, and starts nothing", async () => {
		const h = build({ providers: { promptClaudeStreamSession } as never });
		await h.handle(action());
		const states = h.posted.filter((p) => p.path.endsWith("/managed-session-state"));
		expect(states).toHaveLength(1);
		expect(states[0]?.body).toMatchObject({ managedState: "degraded", status: "idle" });
		expect(h.statuses().at(-1)).toMatchObject({
			status: "failed",
			error: CLAUDE_FORK_NO_RUNTIME_ERROR,
		});
		expect(h.spawned.headless).toBe(0);
	});

	test("never falls through to the one-prompt path when the stream fails, and the failure carries fixed words, not the detail", async () => {
		const logged: string[] = [];
		const h = build({
			log: (line) => logged.push(line),
			providers: {
				promptClaudeStreamSession: async () => {
					throw new Error("boom with detail /Users/someone/secret-path");
				},
			} as never,
		});
		await h.handle(action());
		expect(h.spawned.headless).toBe(0);
		const last = h.statuses().at(-1);
		expect(last).toMatchObject({
			status: "failed",
			error: "The prompt couldn't be sent. Try again.",
		});
		expect(JSON.stringify(h.posted)).not.toContain("secret-path");
		// the detail is the host's own to read
		expect(logged.join("\n")).toContain("secret-path");
	});
});

describe("the one-prompt path and the stream never share an id", () => {
	const headlessAction = () =>
		action(
			{},
			{
				runtime: undefined,
				launchMode: "headless",
				model: null,
				approvalPolicy: null,
				sandboxMode: null,
				env: {},
			},
		);

	test("a thread-record fork with no metadata.runtime (an old server) is refused, and nothing is spawned", async () => {
		const h = build({ forkStatus: (id) => (id === SESSION ? "fork" : "not_fork") });
		await h.handle(headlessAction());
		expect(h.spawned).toEqual({ headless: 0, stream: 0, stop: 0 });
		expect(h.statuses().at(-1)).toMatchObject({
			status: "failed",
			error: CLAUDE_FORK_NOT_HEADLESS_ERROR,
		});
	});

	test("headless is refused when a stream runtime holds the id", async () => {
		const h = build({ providers: { hasClaudeStreamRuntime: () => true } as never });
		await h.handle(headlessAction());
		expect(h.spawned.headless).toBe(0);
		expect(h.statuses().at(-1)).toMatchObject({
			status: "failed",
			error: CLAUDE_STREAM_HELD_ERROR,
		});
	});

	test("the stream is refused when a one-prompt child holds the id", async () => {
		const h = build({ providers: { hasHeadlessRuntime: () => true } as never });
		await h.handle(action());
		expect(h.spawned.stream).toBe(0);
		expect(h.statuses().at(-1)).toMatchObject({
			status: "failed",
			error: CLAUDE_STREAM_HELD_ERROR,
		});
	});

	test("a record that can't be read refuses the one-prompt path too: it can't tell a fork from a launched session", async () => {
		const h = build({ forkStatus: () => "unknown" });
		await h.handle(headlessAction());
		expect(h.spawned.headless).toBe(0);
		expect(h.statuses().at(-1)).toMatchObject({
			status: "failed",
			error: CLAUDE_FORK_RECORD_UNREADABLE_ERROR,
		});
	});

	test("a launched session (not a recorded fork, no stream) still takes the one-prompt path", async () => {
		const h = build({ forkStatus: () => "not_fork" });
		await h.handle(headlessAction());
		expect(h.spawned.headless).toBe(1);
	});
});

describe("stopping a fork", () => {
	const stopAction = (runtime = "claude_stream") =>
		action({ actionType: "stop" }, { runtime, prompt: undefined });

	test("reports the session stopped, then the action succeeded", async () => {
		const h = build();
		await h.handle(stopAction());
		expect(h.spawned.stop).toBe(1);
		const states = h.posted.filter((p) => p.path.endsWith("/managed-session-state"));
		expect(states[0]?.body).toMatchObject({ managedState: "stopped" });
		expect(h.statuses().at(-1)).toMatchObject({ status: "succeeded" });
	});

	test("with no process registered it still reads stopped, says nothing was running, and cancels no launch", async () => {
		const h = build({
			providers: {
				stopClaudeStreamSession: async () => ({ hadChild: false, gone: true, unchecked: false }),
			} as never,
		});
		await h.handle(stopAction());
		const events = h.posted
			.filter((p) => p.path.endsWith("/events"))
			.flatMap((p) => p.body.events ?? []);
		expect(events.some((e: { content?: string }) => e.content === NOTHING_RUNNING_STOP_NOTE)).toBe(
			true,
		);
		expect(h.posted.some((p) => p.path.includes("/launches/"))).toBe(false);
		expect(h.statuses().at(-1)).toMatchObject({ status: "succeeded" });
	});

	test("a child whose tree was never looked at is stopped with the unchecked note", async () => {
		const h = build({
			providers: {
				stopClaudeStreamSession: async () => ({ hadChild: true, gone: true, unchecked: true }),
			} as never,
		});
		await h.handle(stopAction());
		const events = h.posted
			.filter((p) => p.path.endsWith("/events"))
			.flatMap((p) => p.body.events ?? []);
		expect(events.some((e: { content?: string }) => e.content === STOPPED_UNCHECKED_NOTE)).toBe(
			true,
		);
	});

	test("something still there after SIGKILL fails the stop with the finishing words", async () => {
		const h = build({
			providers: {
				stopClaudeStreamSession: async () => ({ hadChild: true, gone: false, unchecked: false }),
			} as never,
		});
		await h.handle(stopAction());
		expect(h.statuses().at(-1)).toMatchObject({ status: "failed", error: STOP_WORDS.finishing });
		expect(h.posted.filter((p) => p.path.endsWith("/managed-session-state"))).toHaveLength(0);
	});

	test("a throw fails the stop with the fixed words, not the detail", async () => {
		const h = build({
			providers: {
				stopClaudeStreamSession: async () => {
					throw new Error("detail /Users/x");
				},
			} as never,
		});
		await h.handle(stopAction());
		expect(h.statuses().at(-1)).toMatchObject({ status: "failed", error: STOP_WORDS.failed });
	});
});
