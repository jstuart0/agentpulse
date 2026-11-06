/**
 * AGEN-110: the headless Claude registry and its stop, against real child processes (a fake `claude` whose
 * tool process leads its own session, which a group signal would miss). Every real signal goes through a
 * signal guard (D10) that sends only to a pid this test started, every wait is a few hundred
 * milliseconds, and nothing reads a real Claude config.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { fakeClaudeReady } from "../test-utils/fake-claude.js";
import {
	type SignalGuard,
	createSignalGuard,
	installDescendantKiller,
} from "../test-utils/signal-guard.js";
import {
	disposeAllHeadlessRuntimes,
	headlessRuntimeCount,
	stopHeadlessClaude,
	streamHeadlessClaude,
} from "./claude-headless.js";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude-tree.ts");
const TIMINGS = { termMs: 250, killMs: 3000 };

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const dirs: string[] = [];
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const strays: number[] = [];
let guard: SignalGuard;
let restoreKiller: () => void;
beforeEach(() => {
	guard = createSignalGuard();
	restoreKiller = installDescendantKiller(guard);
});
afterEach(async () => {
	await disposeAllHeadlessRuntimes(100, 3000);
	for (const pid of strays.splice(0)) {
		try {
			guard.killPid(pid, "SIGKILL");
		} catch {}
	}
	restoreKiller();
	for (const proc of spawned.splice(0)) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	// A stop that went for a pid outside the test's tree was refused: a failure of the code under test.
	expect(guard.refused).toEqual([]);
});

function entries(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function until(check: () => boolean, what: string) {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

const metadata = () => ({
	mode: "headless" as const,
	command: [],
	resolvedExecutable: "claude",
	startedAt: new Date().toISOString(),
	executionState: "running" as const,
	output: { assistantPreview: "", stderrPreview: "", activity: [], rawEventCount: 0 },
});

/** Runs the fake under streamHeadlessClaude, as a launch or a prompt would, and records every report. */
async function startHeadless(sessionId: string, env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ap-headless-stop-"));
	dirs.push(dir);
	const log = join(dir, "fake.log");
	const proc = Bun.spawn({
		cmd: [process.execPath, FAKE],
		env: { ...process.env, FAKE_CLAUDE_LOG: log, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	spawned.push(proc);
	guard.allow(proc.pid);
	const states: ManagedSessionStateInput[] = [];
	const events: ManagedSessionEventInput[] = [];
	const progress: Array<{ status: string; error?: string | null }> = [];
	const result = await streamHeadlessClaude({
		sessionId,
		launchRequestId: "launch-1",
		cwd: dir,
		model: null,
		configCapabilities: {},
		proc,
		metadata: metadata(),
		reportProgress: async (update) => {
			progress.push({ status: update.status, error: update.error });
		},
		callbacks: {
			reportState: async (input) => {
				states.push(input);
				return { session: {} as never, managedSession: {} as never };
			},
			reportEvents: async (batch) => {
				events.push(...batch);
				return "sent" as const;
			},
		},
		startEvent: {
			eventType: "HeadlessTaskStarted",
			category: "system_event",
			content: "s",
			rawPayload: {},
		},
		completionEvent: { success: "HeadlessTaskCompleted", failurePrefix: "HeadlessTaskFailed" },
	});
	await until(() => fakeClaudeReady(entries(log), env), "the fake to be ready");
	const child = entries(log).find((e) => e.role === "child")?.pid as number | undefined;
	if (child) strays.push(guard.allow(child));
	return { proc, result, states, events, progress, child, log };
}

describe("stopHeadlessClaude", () => {
	test("kills the child and the tool process that left its group, and the launch reads cancelled and stopped", async () => {
		const run = await startHeadless("s-stop", { FAKE_CLAUDE_CHILD: "setsid" });
		expect(headlessRuntimeCount()).toBe(1);

		const outcome = await stopHeadlessClaude("s-stop", TIMINGS);
		await run.result.monitor;

		expect(outcome).toEqual({ hadChild: true, gone: true, unchecked: false });
		expect(alive(run.proc.pid)).toBe(false);
		expect(alive(run.child as number)).toBe(false);
		expect(headlessRuntimeCount()).toBe(0);
		expect(run.progress.at(-1)).toEqual({ status: "cancelled", error: null });
		const last = run.states.at(-1);
		expect(last?.managedState).toBe("stopped");
		expect(last?.status).toBe("completed");
		expect(run.events.map((e) => e.eventType)).not.toContain("HeadlessTaskFailed");
		expect(guard.refused).toEqual([]);
	});

	test("a child that ignores SIGTERM is killed, and so is its tool process", async () => {
		const run = await startHeadless("s-term", {
			FAKE_CLAUDE_CHILD: "setsid",
			FAKE_CLAUDE_IGNORE_TERM: "1",
			FAKE_CLAUDE_CHILD_IGNORE_TERM: "1",
		});
		const outcome = await stopHeadlessClaude("s-term", TIMINGS);
		await run.result.monitor;
		expect(outcome.gone).toBe(true);
		expect(alive(run.proc.pid)).toBe(false);
		expect(alive(run.child as number)).toBe(false);
		// It saw the TERM it ignored before the KILL.
		expect(entries(run.log).filter((e) => e.signal === "SIGTERM")).toHaveLength(1);
	});

	test("nothing registered for the id is a no-op the host reports as stopped", async () => {
		expect(await stopHeadlessClaude("never-started", TIMINGS)).toEqual({
			hadChild: false,
			gone: true,
			unchecked: false,
		});
	});

	test("another session's child is left running", async () => {
		const mine = await startHeadless("s-mine");
		const other = await startHeadless("s-other");
		await stopHeadlessClaude("s-mine", TIMINGS);
		await mine.result.monitor;
		expect(alive(other.proc.pid)).toBe(true);
		expect(headlessRuntimeCount()).toBe(1);
		expect(guard.refused).toEqual([]);
	});

	test("a child that exits on its own, not stopped, is still reported failed", async () => {
		const run = await startHeadless("s-crash");
		run.proc.kill("SIGKILL");
		await run.result.monitor;
		expect(run.progress.at(-1)?.status).toBe("failed");
		expect(run.states.at(-1)?.managedState).toBe("failed");
		expect(run.events.map((e) => e.eventType)).toContain("HeadlessTaskFailed");
	});
});

describe("two children for one session id", () => {
	test("the first one's exit doesn't take the second out of the count or out of disposal", async () => {
		// A lapsed lock can let a second prompt spawn while the first still runs (P2 closes that);
		// the registry must never lose a child to it.
		const first = await startHeadless("s-twice");
		const second = await startHeadless("s-twice");
		expect(headlessRuntimeCount()).toBe(2);

		first.proc.kill("SIGKILL");
		await first.result.monitor;
		expect(headlessRuntimeCount()).toBe(1);
		expect(alive(second.proc.pid)).toBe(true);

		await disposeAllHeadlessRuntimes(150, 3000);
		await second.result.monitor;
		expect(alive(second.proc.pid)).toBe(false);
		expect(headlessRuntimeCount()).toBe(0);
	});

	test("a stop reaches both", async () => {
		const first = await startHeadless("s-both");
		const second = await startHeadless("s-both");
		const outcome = await stopHeadlessClaude("s-both", TIMINGS);
		await Promise.all([first.result.monitor, second.result.monitor]);
		expect(outcome).toEqual({ hadChild: true, gone: true, unchecked: false });
		expect(alive(first.proc.pid)).toBe(false);
		expect(alive(second.proc.pid)).toBe(false);
	});
});

describe("disposal on a fatal exit", () => {
	test("reaches a tool process that left the child's group", async () => {
		const run = await startHeadless("s-dispose", { FAKE_CLAUDE_CHILD: "setsid" });
		await disposeAllHeadlessRuntimes(250, 3000);
		await run.result.monitor;
		expect(alive(run.proc.pid)).toBe(false);
		expect(alive(run.child as number)).toBe(false);
	});
});

describe("a prompt after a Stop (AGEN-110: the next prompt starts a new process for the same id)", () => {
	test("a second child for an id whose first was stopped is registered, counted, and stopped on its own", async () => {
		const first = await startHeadless("s-again", { FAKE_CLAUDE_CHILD: "setsid" });
		await stopHeadlessClaude("s-again", TIMINGS);
		await first.result.monitor;
		expect(headlessRuntimeCount()).toBe(0);
		expect(first.progress.at(-1)).toEqual({ status: "cancelled", error: null });

		const second = await startHeadless("s-again", { FAKE_CLAUDE_CHILD: "setsid" });
		expect(headlessRuntimeCount()).toBe(1);
		expect(alive(second.proc.pid)).toBe(true);

		const outcome = await stopHeadlessClaude("s-again", TIMINGS);
		await second.result.monitor;
		expect(outcome).toEqual({ hadChild: true, gone: true, unchecked: false });
		expect(alive(second.proc.pid)).toBe(false);
		expect(alive(second.child as number)).toBe(false);
		expect(second.progress.at(-1)).toEqual({ status: "cancelled", error: null });
	});

	test("the first stop leaves no mark on the second child: one that dies on its own is reported failed", async () => {
		const first = await startHeadless("s-mark");
		await stopHeadlessClaude("s-mark", TIMINGS);
		await first.result.monitor;
		const second = await startHeadless("s-mark");
		second.proc.kill("SIGKILL");
		await second.result.monitor;
		expect(second.progress.at(-1)?.status).toBe("failed");
		expect(second.states.at(-1)?.managedState).toBe("failed");
	});
});

describe("a stop that could not look for the commands under the child", () => {
	test("the child is stopped, 'gone' is true, and the outcome says it was unchecked (a table that never answers)", async () => {
		const run = await startHeadless("s-unchecked", { FAKE_CLAUDE_CHILD: "setsid" });
		const outcome = await stopHeadlessClaude("s-unchecked", TIMINGS, {
			table: { list: async () => [] },
		});
		await run.result.monitor;
		expect(outcome).toEqual({ hadChild: true, gone: true, unchecked: true });
		expect(alive(run.proc.pid)).toBe(false);
		// Nothing was looked for, so nothing under it was touched: the tool process is left, and said so.
		expect(alive(run.child as number)).toBe(true);
		expect(guard.refused).toEqual([]);
	});
});
