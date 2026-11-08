/**
 * AGEN-119: the host's handling of an `interrupt` control action. Real: the control handler and the report gate
 * (transport stubbed). Spied: the providers. The action ends `succeeded` with `{ interrupted, beforeSend? }` or
 * `failed` with fixed words; it signals nothing, touches no lock and never reaches the Stop path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TURN_DIDNT_STOP, TURN_STOP_NOT_SENT } from "../shared/stop-turn.js";
import type { ControlAction } from "../shared/types.js";
import {
	type ControlProviders,
	STOP_WORDS,
	createControlActionHandler,
} from "./control-actions.js";
import type { InterruptResult } from "./providers/claude-stream.js";
import { createReportGate } from "./services/report-gate.js";

const SESSION = "claude-session-1";
let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-claude-interrupt-")));
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(interrupt: (sessionId: string, target: string) => Promise<InterruptResult>) {
	const calls: string[] = [];
	const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
	const logged: string[] = [];
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
	const providers = {
		stopManagedCodexSession: async () => void calls.push("codex-stop"),
		stopHeadlessClaude: async () => {
			calls.push("headless-stop");
			return { hadChild: true, gone: true };
		},
		stopClaudeStreamSession: async () => {
			calls.push("stream-stop");
			return { hadChild: true, gone: true, unchecked: false };
		},
		interruptClaudeStreamSession: async (sessionId: string, target: string) => {
			calls.push(`interrupt:${sessionId}:${target}`);
			return interrupt(sessionId, target);
		},
		hasManagedCodexRuntime: () => false,
		hasClaudeStreamRuntime: () => true,
		hasHeadlessRuntime: () => false,
	} as unknown as ControlProviders;
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [home],
		providers,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: home })) as never,
		log: (line: string) => void logged.push(line),
	});
	const status = () =>
		posted.filter((p) => p.path.endsWith("/control-actions/act-1/status")).map((p) => p.body);
	const stateReports = () => posted.filter((p) => p.path.endsWith("/managed-session-state"));
	return { calls, handle, status, stateReports, logged, posted };
}

const interrupt = (
	metadata: Record<string, unknown> | null = {
		runtime: "claude_stream",
		targetPromptActionId: "p1",
	},
) =>
	({
		id: "act-1",
		sessionId: SESSION,
		launchRequestId: "launch-1",
		actionType: "interrupt",
		status: "running",
		metadata,
	}) as unknown as ControlAction;

describe("an interrupt action", () => {
	test("a turn that stopped: succeeded, interrupted true, the target named to the runtime, no stop, no state report", async () => {
		const h = harness(async () => ({ status: "interrupted" }));
		await h.handle(interrupt());
		expect(h.calls).toEqual([`interrupt:${SESSION}:p1`]);
		const [reported] = h.status();
		expect(reported).toMatchObject({ status: "succeeded" });
		expect(reported?.metadata).toMatchObject({ interrupted: true });
		expect((reported?.metadata as Record<string, unknown>).beforeSend).toBeUndefined();
		expect(h.stateReports()).toEqual([]);
	});

	test("cancelled before the prompt was sent: interrupted true and beforeSend true", async () => {
		const h = harness(async () => ({ status: "interrupted", beforeSend: true }));
		await h.handle(interrupt());
		expect(h.status()[0]?.metadata).toMatchObject({ interrupted: true, beforeSend: true });
	});

	test("a turn that had ended its own way: succeeded with interrupted false", async () => {
		const h = harness(async () => ({ status: "not_interrupted" }));
		await h.handle(interrupt());
		expect(h.status()[0]).toMatchObject({ status: "succeeded" });
		expect(h.status()[0]?.metadata).toMatchObject({ interrupted: false });
	});

	test("Claude did not stop in time: failed with the fixed words", async () => {
		const h = harness(async () => ({ status: "didnt_stop" }));
		await h.handle(interrupt());
		expect(h.status()).toEqual([{ status: "failed", error: TURN_DIDNT_STOP }]);
	});

	test("the interrupt could not be written, or the runtime threw: fixed words, the detail only in the host log", async () => {
		const h = harness(async () => ({ status: "not_sent" }));
		await h.handle(interrupt());
		expect(h.status()).toEqual([{ status: "failed", error: TURN_STOP_NOT_SENT }]);
		const throwing = harness(async () => {
			throw new Error("secret detail /Users/x/.claude");
		});
		await throwing.handle(interrupt());
		expect(throwing.status()).toEqual([{ status: "failed", error: TURN_STOP_NOT_SENT }]);
		expect(JSON.stringify(throwing.status())).not.toContain("secret detail");
		expect(throwing.logged.join("\n")).toContain("secret detail");
	});

	test.each([
		["no runtime named (an old server)", { targetPromptActionId: "p1" }],
		["Codex's runtime", { runtime: "codex", targetPromptActionId: "p1" }],
		["a headless runtime", { runtime: "claude_headless", targetPromptActionId: "p1" }],
		["no target", { runtime: "claude_stream" }],
		["a non-string target", { runtime: "claude_stream", targetPromptActionId: 7 }],
	])("%s fails with fixed words and calls nothing", async (_name, metadata) => {
		const h = harness(async () => ({ status: "interrupted" }));
		await h.handle(interrupt(metadata));
		expect(h.calls).toEqual([]);
		expect(h.status()).toEqual([{ status: "failed", error: STOP_WORDS.unsupported }]);
	});

	test("it never reaches a stop path of any runtime", async () => {
		const h = harness(async () => ({ status: "interrupted" }));
		await h.handle(interrupt());
		expect(h.calls.some((c) => c.endsWith("-stop"))).toBe(false);
	});
});
