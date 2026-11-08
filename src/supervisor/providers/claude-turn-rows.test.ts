/**
 * AGEN-122: the structured outcome a fork's call row carries. The recorded Claude streams are replayed through
 * the real runtime (a fake `claude` speaking the recorded lines), the runtime's own call records are taken from
 * `onCallResulted`, and `callRowPayload` is judged on those, so the table below reads Claude's real shapes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FORK_CALL_OUTCOMES } from "../../shared/claude-fork-copy.js";
import { turnsOf } from "../test-utils/claude-fixture-replay.js";
import { type Harness, createHarness, until } from "../test-utils/claude-stream-harness.js";
import { CLAUDE_FIXTURE_DIR_2_1_319, readClaudeFixture } from "./__fixtures__/claude-frames.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import {
	type CallRowContext,
	bashExitCodeOf,
	callRowPayload,
	callRowText,
} from "./claude-turn-rows.js";
import { type ToolCallRecord, newToolCallRecord } from "./fork-tool-record.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) h.cleanup();
});

/** Replays a recording and returns the call records the runtime built, in the order they resulted. */
async function recordedCalls(name: string, dir?: string): Promise<ToolCallRecord[]> {
	const turns = turnsOf(readClaudeFixture(name, dir));
	const calls: ToolCallRecord[] = [];
	const h = createHarness({ turns });
	harnesses.push(h);
	const rt = await h.start({ onCallResulted: (c) => void calls.push(c) });
	rt.beginSettle();
	rt.settled();
	for (let i = 0; i < turns.length; i++) {
		const sent = await rt.sendPrompt("go", `a${i}`);
		await Promise.race([sent.done, Bun.sleep(2_500)]);
	}
	await until(() => calls.length > 0 || turns.length === 0, "a call result");
	return calls;
}

const RUNNING: CallRowContext = { turnOutcome: "running" };
const INTERRUPTED: CallRowContext = { turnOutcome: "interrupted" };

describe("recorded streams to call-row outcomes", () => {
	const table: Array<{
		fixture: string;
		dir?: string;
		ctx: CallRowContext;
		expected: Array<{ tool: string; toolOutcome: string; exit_code?: number }>;
	}> = [
		{
			fixture: "bash-fail",
			ctx: RUNNING,
			expected: [
				{ tool: "Bash", toolOutcome: "declined" },
				{ tool: "Bash", toolOutcome: "failed", exit_code: 3 },
			],
		},
		{
			fixture: "user-reject",
			ctx: RUNNING,
			expected: [{ tool: "Write", toolOutcome: "declined" }],
		},
		{
			fixture: "cancel-hook-deny",
			ctx: RUNNING,
			expected: [{ tool: "Bash", toolOutcome: "refused" }],
		},
		{
			fixture: "cancel-hook-allow",
			ctx: RUNNING,
			expected: [{ tool: "Bash", toolOutcome: "unasked" }],
		},
		{
			fixture: "unknown-request",
			ctx: RUNNING,
			expected: [
				{ tool: "Write", toolOutcome: "refused" },
				{ tool: "Write", toolOutcome: "refused" },
			],
		},
		// The recorded interrupt: the error is the interrupt's. In a turn that is not interrupted it reads as before.
		{
			fixture: "cancel-interrupt",
			ctx: INTERRUPTED,
			expected: [{ tool: "Bash", toolOutcome: "stopped" }],
		},
		{
			fixture: "cancel-interrupt",
			ctx: RUNNING,
			expected: [{ tool: "Bash", toolOutcome: "refused" }],
		},
		{
			fixture: "int-bash-key",
			dir: CLAUDE_FIXTURE_DIR_2_1_319,
			ctx: INTERRUPTED,
			expected: [{ tool: "Bash", toolOutcome: "stopped" }],
		},
	];

	for (const row of table) {
		test(`${row.fixture} (${row.ctx.turnOutcome})`, async () => {
			const calls = await recordedCalls(row.fixture, row.dir);
			const payloads = calls.map((c) => callRowPayload(c, row.ctx));
			expect(
				payloads.map((p) => ({
					tool: p.tool,
					toolOutcome: p.toolOutcome,
					...(p.exit_code === undefined ? {} : { exit_code: p.exit_code }),
				})),
			).toEqual(row.expected);
			for (const p of payloads) {
				expect(typeof p.tool_use_id).toBe("string");
				expect(typeof p.is_error).toBe("boolean");
				expect(FORK_CALL_OUTCOMES as readonly string[]).toContain(p.toolOutcome as string);
				// A stopped call never carries a code, and no key beyond the five can appear.
				expect(
					Object.keys(p).every((k) =>
						["tool", "toolOutcome", "is_error", "exit_code", "tool_use_id"].includes(k),
					),
				).toBe(true);
				if (p.toolOutcome === "stopped") expect(p).not.toHaveProperty("exit_code");
			}
		}, 20_000);
	}

	test("population floor: the table judged at least six call rows, with a failed, a stopped and a declined one", async () => {
		let n = 0;
		const seen = new Set<string>();
		for (const row of table) {
			for (const e of row.expected) {
				n++;
				seen.add(e.toolOutcome);
			}
		}
		expect(n).toBeGreaterThanOrEqual(6);
		for (const outcome of ["failed", "stopped", "declined", "refused", "unasked"]) {
			expect(seen.has(outcome), outcome).toBe(true);
		}
	});

	test("the stopped words", async () => {
		const [call] = await recordedCalls("cancel-interrupt");
		expect(callRowText(call as ToolCallRecord, undefined, INTERRUPTED)).toBe(
			"Bash: stopped when you stopped the turn",
		);
	}, 20_000);
});

describe("exit codes: only what Claude printed", () => {
	const bash = (text: string | null, over: Partial<ToolCallRecord> = {}) =>
		newToolCallRecord({
			toolUseId: "toolu_x",
			name: "Bash",
			resulted: true,
			isError: true,
			detailResult: text,
			...over,
		});
	const code = (text: string | null, over: Partial<ToolCallRecord> = {}) => {
		const payload = callRowPayload(bash(text, over), RUNNING);
		return "exit_code" in payload ? payload.exit_code : undefined;
	};

	test("recorded shapes", () => {
		expect(code("Exit code 1")).toBe(1);
		expect(code("Exit code 2")).toBe(2);
		expect(code("Exit code 127\n(eval):1: command not found: nope")).toBe(127);
		expect(code("Exit code 3\nto-out\nto-err")).toBe(3);
		expect(code("Exit code 143\nCommand timed out after 3s")).toBe(143);
		expect(code("Exit code 0")).toBe(0);
		expect(code("Exit code 255")).toBe(255);
	});

	test("anything else is left out", () => {
		for (const text of [
			"Exit code 256",
			"Exit code -1",
			"Exit code 4294967295",
			`Exit code ${"9".repeat(20)}`,
			"Exit code ",
			"Exit code",
			"Exit code 3abc",
			"Exit code 3 and more",
			" Exit code 3",
			"﻿Exit code 3",
			"exit code 3",
			"The command printed Exit code 3",
			"",
			null,
		]) {
			expect(code(text), String(text)).toBeUndefined();
		}
	});

	test("only a failed Bash call, never inferred", () => {
		// A success prints no prefix and carries no code (no made-up 0).
		const ok = callRowPayload(bash("(Bash completed with no output)", { isError: false }), RUNNING);
		expect(ok).not.toHaveProperty("exit_code");
		expect(ok.is_error).toBe(false);
		// Text that looks like a code from a call that did not fail.
		expect(code("Exit code 3", { isError: false })).toBeUndefined();
		// Not Bash.
		expect(code("Exit code 3", { name: "Read" })).toBeUndefined();
		expect(code("Exit code 3", { name: "mcp__srv__tool" })).toBeUndefined();
		// Refused or declined calls print Claude's own words, not a code.
		expect(
			code("Exit code 3", { nonExecutionKind: "permission-rule", decisionSource: "config" }),
		).toBeUndefined();
		// A stopped call.
		expect(
			callRowPayload(bash("Exit code 3", { nonExecutionKind: "user-rejected" }), INTERRUPTED),
		).not.toHaveProperty("exit_code");
		expect(bashExitCodeOf(bash("Exit code 3"))).toBe(3);
	});

	test("an interrupted turn does not relabel a refusal a permission decision made", () => {
		const refused = bash("Claude's words", {
			nonExecutionKind: "permission-rule",
			decisionSource: "config",
		});
		expect(callRowPayload(refused, INTERRUPTED).toolOutcome).toBe("refused");
		const declined = bash("Claude's words", {
			nonExecutionKind: "permission-rule",
			decisionSource: "user_reject",
		});
		expect(callRowPayload(declined, INTERRUPTED).toolOutcome).toBe("declined");
		// A call that did not error keeps its word, interrupted turn or not.
		expect(callRowPayload(bash("ok", { isError: false }), INTERRUPTED).toolOutcome).toBe("unasked");
	});

	test("a text over 16 KiB still parses its prefix", () => {
		expect(code(`Exit code 4\n${"x".repeat(40_000)}`)).toBe(4);
	});
});

describe("tool naming", () => {
	test("an MCP tool is reported as mcp, never by server or tool name", () => {
		const call = newToolCallRecord({
			toolUseId: "t",
			name: "mcp__secretserver__do_it",
			resulted: true,
			isError: true,
		});
		const payload = callRowPayload(call, RUNNING);
		expect(payload.tool).toBe("mcp");
		expect(JSON.stringify(payload)).not.toContain("secretserver");
		expect(payload.toolOutcome).toBe("failed");
		expect(payload).not.toHaveProperty("exit_code");
	});

	test("a name outside the six and not mcp is left out", () => {
		const call = newToolCallRecord({ toolUseId: "t", name: "Surprise", resulted: true });
		expect(callRowPayload(call, RUNNING)).not.toHaveProperty("tool");
	});

	test("a successful MCP call: no is_error", () => {
		const call = newToolCallRecord({ toolUseId: "t", name: "mcp__s__t", resulted: true });
		expect(callRowPayload(call, RUNNING)).toMatchObject({
			tool: "mcp",
			toolOutcome: "unasked",
			is_error: false,
		});
	});
});
