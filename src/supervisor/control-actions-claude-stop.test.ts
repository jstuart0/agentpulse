/**
 * AGEN-110: Stop on a launched Claude session. The server stamps `metadata.runtime` on the stop action; the
 * host branches on it. Codex (or an action with no runtime, from an older server) goes to the Codex stop and
 * nowhere else; a headless Claude goes to the headless stop; a terminal launch and any runtime this build
 * can't stop fail with fixed words and touch no process.
 *
 * Real: the control handler and the report gate (transport stubbed). Spied: the providers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOTHING_RUNNING_STOP_NOTE,
	STOPPED_UNCHECKED_NOTE,
	STOP_FAILED_ERROR,
} from "../shared/managed-messages.js";
import { STOP_RUNTIMES, STOP_RUNTIME_VALUES } from "../shared/stop-runtime.js";
import type { ControlAction } from "../shared/types.js";
import {
	type ControlProviders,
	STOP_WORDS,
	createControlActionHandler,
} from "./control-actions.js";
import { createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const SESSION = "claude-session-1";
const LAUNCH = "launch-1";

let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-claude-stop-")));
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Posted = { path: string; body: Record<string, unknown> };
type HeadlessStop = { hadChild: boolean; gone: boolean; unchecked?: boolean };

function harness(
	headless: HeadlessStop | Error = { hadChild: true, gone: true },
	opts: { launchReportFails?: boolean; codexStopFails?: Error; stream?: HeadlessStop } = {},
) {
	const calls: string[] = [];
	const posted: Posted[] = [];
	const logged: string[] = [];
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			if (opts.launchReportFails && path.includes("/launches/")) {
				throw new Error("launch endpoint down");
			}
			posted.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	} as never);
	const providers = {
		stopManagedCodexSession: async (id: string) => {
			calls.push(`codex:${id}`);
			if (opts.codexStopFails) throw opts.codexStopFails;
		},
		stopHeadlessClaude: async (id: string) => {
			calls.push(`headless:${id}`);
			if (headless instanceof Error) throw headless;
			return headless;
		},
		stopClaudeStreamSession: async (id: string) => {
			calls.push(`stream:${id}`);
			return opts.stream ?? { hadChild: true, gone: true, unchecked: false };
		},
		hasManagedCodexRuntime: () => false,
		hasClaudeStreamRuntime: () => false,
		hasHeadlessRuntime: () => false,
	} as unknown as ControlProviders;
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [home],
		providers,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: home })) as never,
		log: (line: string) => void logged.push(line),
	});
	const stateReports = () => posted.filter((p) => p.path.endsWith("/managed-session-state"));
	const statusReports = () =>
		posted.filter((p) => p.path.endsWith("/control-actions/act-1/status"));
	const launchReports = () => posted.filter((p) => p.path.includes("/launches/"));
	const events = () =>
		posted
			.filter((p) => p.path.endsWith(`/managed-sessions/${SESSION}/events`))
			.flatMap((p) => (p.body.events ?? p.body) as Array<Record<string, unknown>>);
	return { calls, posted, logged, handle, stateReports, statusReports, launchReports, events };
}

function stop(metadata: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
	return {
		id: "act-1",
		sessionId: SESSION,
		launchRequestId: LAUNCH,
		actionType: "stop",
		status: "running",
		metadata,
		...over,
	} as unknown as ControlAction;
}

describe("Codex is unchanged", () => {
	test.each([
		["no metadata at all (an older server)", null],
		["an empty metadata object", {}],
		["runtime codex", { runtime: "codex" }],
	])("%s goes to the Codex stop and reports stopped", async (_name, metadata) => {
		const h = harness();
		await h.handle(stop(metadata));
		expect(h.calls).toEqual([`codex:${SESSION}`]);
		expect(h.stateReports().map((p) => p.body.managedState)).toEqual(["stopped"]);
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
		expect(h.launchReports()).toEqual([]);
	});
});

describe("a launched headless Claude", () => {
	test("the headless stop runs, never the Codex one, and the session reads stopped", async () => {
		const h = harness({ hadChild: true, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.calls).toEqual([`headless:${SESSION}`]);
		expect(h.stateReports().map((p) => [p.body.status, p.body.managedState])).toEqual([
			["completed", "stopped"],
		]);
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
	});

	test("with a child the launch's exit path reports the launch, so the handler doesn't", async () => {
		const h = harness({ hadChild: true, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.launchReports()).toEqual([]);
	});

	test("with no child registered it still reports stopped and cancels the launch", async () => {
		const h = harness({ hadChild: false, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.stateReports().map((p) => p.body.managedState)).toEqual(["stopped"]);
		expect(h.launchReports().map((p) => [p.path.split("/launches/")[1], p.body.status])).toEqual([
			[`${LAUNCH}/status`, "cancelled"],
		]);
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
	});

	test("with no child and no launch id on the action, nothing is cancelled", async () => {
		const h = harness({ hadChild: false, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }, { launchRequestId: null }));
		expect(h.launchReports()).toEqual([]);
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
	});

	test("a child still there after SIGKILL fails the action in plain words, and the session isn't called stopped", async () => {
		const h = harness({ hadChild: true, gone: false });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.stateReports()).toEqual([]);
		const [status] = h.statusReports();
		expect(status?.body.status).toBe("failed");
		expect(status?.body.error).toBe(
			"A command on this machine is still finishing, so the session can't be stopped yet. Try again when it's done.",
		);
	});

	test("a stop that throws fails the action with fixed words; the detail stays in the host log", async () => {
		const h = harness(new Error("boom: /Users/someone/secret-dir"));
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.statusReports().map((p) => [p.body.status, p.body.error])).toEqual([
			["failed", STOP_FAILED_ERROR],
		]);
		expect(JSON.stringify(h.posted)).not.toContain("secret-dir");
		expect(h.logged.join("\n")).toContain("secret-dir");
	});

	test("a Codex stop that throws is the same: fixed words out, detail in the log", async () => {
		const h = harness(undefined, { codexStopFails: new Error("codex said: /home/x/private") });
		await h.handle(stop({ runtime: "codex" }));
		expect(h.statusReports().map((p) => [p.body.status, p.body.error])).toEqual([
			["failed", STOP_FAILED_ERROR],
		]);
		expect(JSON.stringify(h.posted)).not.toContain("/home/x/private");
		expect(h.logged.join("\n")).toContain("/home/x/private");
	});

	test("with a child the timeline event says the operator stopped it", async () => {
		const h = harness({ hadChild: true, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.events().map((e) => e.content)).toEqual(["Managed session stopped by operator."]);
	});

	test("with no child the event and the action say nothing was running, and a restart may have left a process", async () => {
		const h = harness({ hadChild: false, gone: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.events().map((e) => [e.eventType, e.content])).toEqual([
			["ManagedSessionStopped", NOTHING_RUNNING_STOP_NOTE],
		]);
		expect(NOTHING_RUNNING_STOP_NOTE).toContain("Nothing was running under this host's control");
		expect(NOTHING_RUNNING_STOP_NOTE).toContain("may still be running");
		expect(NOTHING_RUNNING_STOP_NOTE).not.toContain("stopped by operator");
		const [status] = h.statusReports();
		expect(status?.body).toMatchObject({
			status: "succeeded",
			metadata: { runtime: "claude_headless", note: NOTHING_RUNNING_STOP_NOTE },
		});
	});

	test("a child that was stopped but whose tool processes were never looked for: stopped, in honest words, not the clean line", async () => {
		const h = harness({ hadChild: true, gone: true, unchecked: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.events().map((e) => [e.eventType, e.content])).toEqual([
			["ManagedSessionStopped", STOPPED_UNCHECKED_NOTE],
		]);
		expect(STOPPED_UNCHECKED_NOTE).toBe(
			"Claude stopped, but AgentPulse couldn't check for commands it started; some may still be running.",
		);
		expect(h.stateReports().map((p) => p.body.managedState)).toEqual(["stopped"]);
		const [status] = h.statusReports();
		expect(status?.body).toMatchObject({
			status: "succeeded",
			metadata: { runtime: "claude_headless", note: STOPPED_UNCHECKED_NOTE },
		});
		// The launch is the child's own exit path's to report; this branch had a child.
		expect(h.launchReports()).toEqual([]);
	});

	test("a launch cancel that fails doesn't fail a stop that is done: it is logged", async () => {
		const h = harness({ hadChild: false, gone: true }, { launchReportFails: true });
		await h.handle(stop({ runtime: "claude_headless" }));
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
		expect(h.stateReports().map((p) => p.body.managedState)).toEqual(["stopped"]);
		expect(h.logged.join("\n")).toContain("cancelling launch after a stop failed");
	});
});

describe("runtimes with no stop path here", () => {
	const TERMINAL =
		"A Claude session running in a terminal can't be stopped from AgentPulse. Close it in the terminal.";
	const UNSUPPORTED = "This host can't stop this kind of session.";

	test("a terminal launch fails with fixed words and touches no process", async () => {
		const h = harness();
		await h.handle(stop({ runtime: "claude_terminal" }));
		expect(h.calls).toEqual([]);
		expect(h.stateReports()).toEqual([]);
		expect(h.statusReports().map((p) => [p.body.status, p.body.error])).toEqual([
			["failed", TERMINAL],
		]);
	});

	test.each([["something_new"], [42]])(
		"runtime %p fails with fixed words and touches no process",
		async (runtime) => {
			const h = harness();
			await h.handle(stop({ runtime }));
			expect(h.calls).toEqual([]);
			expect(h.stateReports()).toEqual([]);
			expect(h.statusReports().map((p) => [p.body.status, p.body.error])).toEqual([
				["failed", UNSUPPORTED],
			]);
		},
	);
});

describe("every runtime the server can name (src/shared/stop-runtime.ts)", () => {
	// Every value the server can emit must reach a real stop path (claude_stream's was wired in AGEN-117 P3).
	test.each([...STOP_RUNTIME_VALUES])(
		"%s is not answered with the unsupported words",
		async (runtime) => {
			const h = harness();
			await h.handle(stop({ runtime }));
			const errors = h.statusReports().map((p) => p.body.error);
			expect(errors).not.toContain(STOP_WORDS.unsupported);
			expect(h.statusReports()).toHaveLength(1);
		},
	);

	test("claude_stream goes to the fork's stop, never to the Codex or one-prompt stop, and the session reads stopped", async () => {
		const h = harness();
		await h.handle(stop({ runtime: STOP_RUNTIMES.claudeStream }));
		expect(h.calls).toEqual([`stream:${SESSION}`]);
		expect(h.stateReports().map((p) => p.body.managedState)).toEqual(["stopped"]);
		expect(h.statusReports().map((p) => p.body.status)).toEqual(["succeeded"]);
		// The carrier launch is not running: there is nothing to cancel.
		expect(h.launchReports()).toEqual([]);
	});

	test("the list the test walks is the whole list: four runtimes, claude_stream among them", () => {
		expect([...STOP_RUNTIME_VALUES].map(String).sort()).toEqual([
			"claude_headless",
			"claude_stream",
			"claude_terminal",
			"codex",
		]);
	});
});
