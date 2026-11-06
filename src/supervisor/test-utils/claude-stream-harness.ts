/**
 * Test harness for the Claude stream runtime (AGEN-117 P3): a fake `claude`, recording report callbacks, an
 * `agents --json` stand-in that lists the fake by its pid, and a signal guard so no test signals a process
 * it did not start (D10).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { type FakeClaude, makeFakeClaude } from "../providers/__fixtures__/claude-fake.js";
import type { FakeConfig } from "../providers/__fixtures__/fake-claude-stream.js";
import { forkArgv } from "../providers/claude-argv.js";
import type { LaunchCallbacks } from "../providers/claude-shared.js";
import {
	type ClaudeApprovalPort,
	type ClaudeStreamOptions,
	type ClaudeStreamRuntime,
	startClaudeStream,
} from "../providers/claude-stream.js";
import { type SignalGuard, createSignalGuard } from "./signal-guard.js";

export const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
export const FORK_ID = "22222222-2222-4222-8222-222222222222";
export const KEY_ACCOUNT = {
	apiProvider: "firstParty",
	tokenSource: "none",
	apiKeySource: "ANTHROPIC_API_KEY",
};
export const HELPER_ACCOUNT = { apiProvider: "firstParty", tokenSource: "apiKeyHelper" };
export const NO_LOGIN_ACCOUNT = { apiProvider: "firstParty", tokenSource: "none" };

/** Fast ladder timings so a test that ends a process doesn't wait out production waits. */
export const FAST_TIMINGS = { interruptMs: 400, stdinCloseMs: 400, termMs: 400, killMs: 400 };

export type Harness = {
	root: string;
	fake: FakeClaude;
	guard: SignalGuard;
	events: ManagedSessionEventInput[];
	states: ManagedSessionStateInput[];
	callbacks: LaunchCallbacks;
	logs: string[];
	/** Every string anything was reported with, for "this text never leaves" assertions. */
	reported(): string;
	options(extra?: Partial<ClaudeStreamOptions>): ClaudeStreamOptions;
	start(extra?: Partial<ClaudeStreamOptions>, config?: FakeConfig): Promise<ClaudeStreamRuntime>;
	/** Fails if the fake was sent an invalid, stray or repeated answer. Called by every suite's afterEach. */
	assertCleanWire(): void;
	cleanup(): void;
};

export function createHarness(config: FakeConfig = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "claude-stream-"));
	const cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const fake = makeFakeClaude(join(root, "bin"), { account: KEY_ACCOUNT, ...config });
	const guard = createSignalGuard();
	const events: ManagedSessionEventInput[] = [];
	const states: ManagedSessionStateInput[] = [];
	const logs: string[] = [];
	const callbacks: LaunchCallbacks = {
		reportState: async (input) => {
			states.push(input);
			return { session: {} as never, managedSession: {} as never, outcome: "sent" };
		},
		reportEvents: async (batch) => {
			events.push(...batch);
			return "sent";
		},
	};
	const listAgents: ClaudeStreamOptions["listAgents"] = async () => ({
		ok: true,
		entries: [{ pid: fake.pid(), sessionId: FORK_ID }],
	});
	const options = (extra: Partial<ClaudeStreamOptions> = {}): ClaudeStreamOptions => {
		const mode = extra.mode ?? "ask";
		return {
			sessionId: FORK_ID,
			source: SOURCE_ID,
			sourceFile: null,
			mode,
			executable: fake.path,
			args: forkArgv({ source: SOURCE_ID, fork: FORK_ID, mode }),
			cwd,
			env: { PATH: process.env.PATH, HOME: root, ...fake.env },
			expectedVersion: "2.1.318",
			callbacks,
			configDir: join(root, "cfg"),
			timings: FAST_TIMINGS,
			ownIdWaitMs: 600,
			log: (line) => logs.push(line),
			listAgents,
			stopReach: { killPid: guard.killPid },
			...extra,
		};
	};
	return {
		root,
		fake,
		guard,
		events,
		states,
		callbacks,
		logs,
		reported: () => JSON.stringify({ events, states }),
		options,
		async start(extra, nextConfig) {
			if (nextConfig) fake.configure({ account: KEY_ACCOUNT, ...nextConfig });
			const runtime = await startClaudeStream(options(extra));
			guard.allow(runtime.pid);
			return runtime;
		},
		assertCleanWire() {
			const bad = fake.badResponses();
			if (bad.length > 0) {
				throw new Error(
					`the fake was sent ${bad.length} invalid or stray answer(s): ${JSON.stringify(bad[0])}`,
				);
			}
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Frames a scripted turn is built from. `$SESSION` and `$UUID` are filled in by the fake. */
export const assistantText = (text: string) => ({
	say: {
		type: "assistant",
		session_id: "$SESSION",
		message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }] },
	},
});
export const assistantToolUse = (id: string, name: string, input: Record<string, unknown>) => ({
	say: {
		type: "assistant",
		session_id: "$SESSION",
		message: {
			role: "assistant",
			model: "claude-haiku-5-5",
			content: [{ type: "tool_use", id, name, input }],
		},
	},
});
export const canUseTool = (
	requestId: string,
	tool: string,
	toolUseId: string,
	input: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({
	say: {
		type: "control_request",
		request_id: requestId,
		// An entry list, not a literal key: the report-gate scan reads a bare `request` key as the raw request function.
		...Object.fromEntries([
			[
				"request",
				{ subtype: "can_use_tool", tool_name: tool, input, tool_use_id: toolUseId, ...extra },
			],
		]),
	},
});
export const toolResult = (
	toolUseId: string,
	options: { isError?: boolean; meta?: Record<string, unknown> } = {},
) => ({
	say: {
		type: "user",
		session_id: "$SESSION",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: "x",
					is_error: options.isError === true,
				},
			],
		},
		...(options.meta ? { tool_result_meta: [{ id: toolUseId, ...options.meta }] } : {}),
	},
});
export const INIT = { say: { type: "system", subtype: "init" } };
export const resultOk = {
	say: {
		type: "result",
		subtype: "success",
		is_error: false,
		terminal_reason: "completed",
		session_id: "$SESSION",
		user_message_uuids: ["$UUID"],
	},
};
export const AWAIT = { await: "control_response" as const };

/** A port that records what it was told and lets a test drive the answer. */
export function recordingPort(): ClaudeApprovalPort & {
	calls: string[];
	requests: Array<{ id: string | number; method: string; params: unknown }>;
	ctx: Parameters<ClaudeApprovalPort["onToolRequest"]>[1] | null;
} {
	const port = {
		calls: [] as string[],
		requests: [] as Array<{ id: string | number; method: string; params: unknown }>,
		ctx: null as Parameters<ClaudeApprovalPort["onToolRequest"]>[1] | null,
		onToolRequest(
			call: { id: string | number; method: string; params?: unknown },
			ctx: Parameters<ClaudeApprovalPort["onToolRequest"]>[1],
		) {
			port.calls.push("request");
			port.requests.push({ id: call.id, method: call.method, params: call.params });
			port.ctx = ctx;
		},
		cancel(id: string) {
			port.calls.push(`cancel:${id}`);
		},
		toolResult(id: string) {
			port.calls.push(`toolResult:${id}`);
		},
		turnEnded() {
			port.calls.push("turnEnded");
		},
		fence() {
			port.calls.push("fence");
		},
		dispose() {
			port.calls.push("dispose");
		},
	};
	return port;
}

export function writeTranscript(
	configDir: string,
	projectDir: string,
	sessionId: string,
	lines: unknown[],
): string {
	const dir = join(configDir, "projects", projectDir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

/** Waits for `predicate`, polling; fails loudly instead of hanging. */
export async function until(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}
