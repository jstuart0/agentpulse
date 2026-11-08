/**
 * AGEN-119..123 Track 0, S3: the turn observer is called exactly once per turn from every way a turn can end,
 * a call's result is announced once its row is queued, and a result that arrives after an interrupt was asked
 * for waits for the turn's real outcome. A fake `claude` built from the recorded lines drives each ending; no
 * real Claude is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FORK_TOOL_DETAIL, FORK_TOOL_DETAIL_LIMITS } from "../../shared/fork-tool-calls.js";
import type { ForkToolCallsReportBody } from "../../shared/fork-tool-calls.js";
import { turnsOf } from "../test-utils/claude-fixture-replay.js";
import {
	AWAIT,
	FAST_TIMINGS,
	type Harness,
	INIT,
	assistantToolUse,
	createHarness,
	resultOk,
	toolResult,
	until,
} from "../test-utils/claude-stream-harness.js";
import { readClaudeFixture } from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import { type ToolCallRecord, createDetailJudge, newToolCallRecord } from "./fork-tool-record.js";
import {
	type ForkTurnObserver,
	type ObservedTurn,
	forkTurnObserver,
	splitIntoBodies,
	toolCallReport,
} from "./fork-turn-observer.js";

const harnesses: Harness[] = [];
function harness(config?: FakeConfig) {
	const h = createHarness(config);
	harnesses.push(h);
	return h;
}

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

function watch() {
	const finished: ObservedTurn[] = [];
	const resulted: ToolCallRecord[] = [];
	return {
		finished,
		resulted,
		options: {
			onTurnFinished: (turn: ObservedTurn) => {
				finished.push(turn);
			},
			onCallResulted: (call: ToolCallRecord) => {
				resulted.push(call);
			},
		},
	};
}

const prompt = async (rt: Awaited<ReturnType<Harness["start"]>>, id = "a1") => {
	rt.beginSettle();
	rt.settled();
	return await rt.sendPrompt("go", id);
};

describe("the turn observer: one call per turn, whichever way it ends", () => {
	test("a result: the turn's unresulted calls are handed over, resulted ones went through onCallResulted", async () => {
		const w = watch();
		const h = harness({
			turns: [
				[
					INIT,
					assistantToolUse("tu-done", "Bash", { command: "ls" }),
					assistantToolUse("tu-open", "Read", { file_path: "/x" }),
					toolResult("tu-done"),
					resultOk,
				],
			],
		});
		const rt = await h.start(w.options);
		await (await prompt(rt)).done;
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ actionId: "a1", ended: "result" });
		expect(w.finished[0]?.calls.map((c) => c.toolUseId)).toEqual(["tu-open"]);
		expect(w.resulted.map((c) => c.toolUseId)).toEqual(["tu-done"]);
		await Bun.sleep(150);
		expect(w.finished).toHaveLength(1);
	});

	test("bash-fail.jsonl: the failed Bash call reaches onCallResulted with its result text and the intact input", async () => {
		const w = watch();
		const h = harness({ turns: turnsOf(readClaudeFixture("bash-fail")) });
		const rt = await h.start(w.options);
		await (await prompt(rt, "a0")).done;
		await (await rt.sendPrompt("go", "a1")).done;
		await until(() => w.finished.length === 2, "two turns");
		expect(w.resulted).toHaveLength(2);
		const failed = w.resulted.find((c) => c.detailResult?.startsWith("Exit code 3"));
		expect(failed).toBeDefined();
		expect(failed?.isError).toBe(true);
		expect(failed?.detailResultBytes).toBeGreaterThan(0);
		expect(typeof (failed?.detailInput as { command?: string })?.command).toBe("string");
		expect(w.finished.map((t) => t.ended)).toEqual(["result", "result"]);
	});

	test("stopped by a result after Stop (the interrupt's own result)", async () => {
		const w = watch();
		const h = harness({
			turns: [[INIT, assistantToolUse("tu", "Bash", { command: "sleep 9" }), { hold: true }]],
		});
		const rt = await h.start(w.options);
		await prompt(rt);
		await rt.stop({ ...FAST_TIMINGS });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "stopped" });
		expect(w.finished[0]?.calls.map((c) => c.toolUseId)).toEqual(["tu"]);
		await Bun.sleep(150);
		expect(w.finished).toHaveLength(1);
	});

	test("stopped with no result at all (End session where the ladder ends the process)", async () => {
		const w = watch();
		const h = harness({ turns: [[INIT, { hold: true }]] });
		const rt = await h.start(w.options);
		await prompt(rt);
		await rt.stop({ ...FAST_TIMINGS, interruptMs: 0 });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "stopped" });
		await Bun.sleep(150);
		expect(w.finished).toHaveLength(1);
	});

	test("first prompt failed: the first init is wrong", async () => {
		const w = watch();
		const h = harness({ init: { tools: ["Bash"] } });
		const rt = await h.start(w.options);
		const done = await (await prompt(rt)).done;
		expect(done).toMatchObject({ ok: false, code: "first_prompt_failed" });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "first_prompt_failed" });
	});

	test("fatal during a turn, then the process exits: still once", async () => {
		const w = watch();
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "command_lifecycle",
							command_uuid: "someone-else",
							state: "started",
							session_id: "$SESSION",
						},
					},
					AWAIT,
				],
			],
		});
		const rt = await h.start(w.options);
		expect(await (await prompt(rt)).done).toMatchObject({ ok: false, code: "fatal" });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "fatal" });
		await Bun.sleep(300);
		expect(w.finished).toHaveLength(1);
	});

	test("the process exits mid-turn", async () => {
		const w = watch();
		const h = harness({
			turns: [[INIT, assistantToolUse("tu", "Bash", { command: "x" }), { exit: 0 }]],
		});
		const rt = await h.start(w.options);
		expect(await (await prompt(rt)).done).toMatchObject({ ok: false, code: "exited" });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "exit" });
		expect(w.finished[0]?.calls.map((c) => c.toolUseId)).toEqual(["tu"]);
	});

	test("dispose mid-turn (the host exits, or a start is refused)", async () => {
		const w = watch();
		const h = harness({ turns: [[INIT, { hold: true }]] });
		const rt = await h.start(w.options);
		await prompt(rt);
		await rt.dispose({ interruptMs: 0, stdinCloseMs: 300, termMs: 300, killMs: 300 });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.finished[0]).toMatchObject({ ended: "exit" });
		await Bun.sleep(150);
		expect(w.finished).toHaveLength(1);
	});

	test("a throwing observer is logged by name and the turn still ends", async () => {
		const h = harness();
		const rt = await h.start({
			onTurnFinished: () => {
				throw new Error("observer-boom");
			},
			onCallResulted: () => {
				throw new Error("observer-boom");
			},
		});
		expect(await (await prompt(rt)).done).toEqual({ ok: true });
		await until(() => h.logs.some((l) => l.includes("the turn observer threw")), "the log line");
		expect(h.logs.join("\n")).not.toContain("session content");
	});
});

describe("the interrupted ending (AGEN-119 adds the trigger; Track 0 reserves the member)", () => {
	test("the default observer accepts it and does nothing", () => {
		const observer: ForkTurnObserver = forkTurnObserver("22222222-2222-4222-8222-222222222222");
		expect(() =>
			observer.onTurnFinished({ actionId: "a", ended: "interrupted", calls: [] }),
		).not.toThrow();
	});
});

describe("a result that arrives after an interrupt was asked for", () => {
	const turn = (): NonNullable<FakeConfig["turns"]>[number] => {
		const frames = turnsOf(readClaudeFixture("cancel-interrupt"))[0] ?? [];
		// INIT, the Bash tool_use, then (with pauses so the test can look) its error result, the interrupt text, the result.
		return [frames[0]!, frames[1]!, { delay: 250 }, frames[2]!, { delay: 500 }, ...frames.slice(3)];
	};

	test("with the flag on: no row and no onCallResulted until the turn ends, then both with the real outcome", async () => {
		const w = watch();
		const h = harness({ turns: [turn()] });
		const rt = await h.start(w.options);
		const sent = await prompt(rt);
		rt._setInterruptRequestedForTest(true);
		await Bun.sleep(450);
		// The tool_result (is_error) has arrived and the result has not.
		expect(w.resulted).toHaveLength(0);
		expect(h.events.filter((e) => e.rawPayload?.kind === "call")).toHaveLength(0);
		const outcome = await sent.done;
		expect(outcome).toMatchObject({ ok: false });
		await until(() => w.finished.length === 1, "the observer");
		expect(w.resulted).toHaveLength(1);
		const rows = h.events.filter((e) => e.rawPayload?.kind === "call");
		expect(rows).toHaveLength(1);
		const order = h.events.map((e) => e.eventType);
		// The call row is in the turn's end batch, before the end event.
		expect(order.indexOf("HeadlessStatus")).toBeLessThan(order.indexOf("HeadlessPromptFailed"));
		expect(w.finished[0]?.calls).toEqual([]);
	});

	test("without the flag (the production case): the same stream emits the row and the callback live", async () => {
		const w = watch();
		const h = harness({ turns: [turn()] });
		const rt = await h.start(w.options);
		const sent = await prompt(rt);
		await Bun.sleep(450);
		expect(w.resulted).toHaveLength(1);
		expect(h.events.filter((e) => e.rawPayload?.kind === "call")).toHaveLength(1);
		await sent.done;
	});

	test("a call that resulted before the interrupt keeps its live row", async () => {
		const w = watch();
		const h = harness({
			turns: [
				[
					INIT,
					assistantToolUse("early", "Bash", { command: "a" }),
					toolResult("early"),
					{ delay: 250 },
					assistantToolUse("late", "Bash", { command: "b" }),
					toolResult("late", { isError: true }),
					{ delay: 200 },
					resultOk,
				],
			],
		});
		const rt = await h.start(w.options);
		const sent = await prompt(rt);
		await Bun.sleep(120);
		rt._setInterruptRequestedForTest(true);
		await Bun.sleep(300);
		expect(w.resulted.map((c) => c.toolUseId)).toEqual(["early"]);
		await sent.done;
		await until(() => w.resulted.length === 2, "the held call");
		expect(w.resulted.map((c) => c.toolUseId)).toEqual(["early", "late"]);
	});
});

describe("the observer sends call detail (AGEN-123)", () => {
	const SESSION = "33333333-3333-4333-8333-333333333333";

	function resultedCall(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
		return newToolCallRecord({
			toolUseId: `toolu_${Math.random().toString(36).slice(2, 10)}`,
			name: "Bash",
			detailInput: { command: "echo hi" },
			detailResult: "hi",
			detailResultBytes: 2,
			resulted: true,
			turnActionId: "act-1",
			detailVerdict: "send",
			...over,
		});
	}

	function rig(over: { offered?: boolean; debounceMs?: number; failWith?: Error } = {}) {
		const bodies: ForkToolCallsReportBody[] = [];
		const lines: string[] = [];
		const stamps: number[] = [];
		const observer = forkTurnObserver(SESSION, {
			send: async (_id, body) => {
				if (over.failWith) throw over.failWith;
				bodies.push(body);
				stamps.push(Date.now());
			},
			serverHas: (feature) => (over.offered ?? true) && feature === FORK_TOOL_DETAIL,
			log: (line) => void lines.push(line),
			debounceMs: over.debounceMs ?? 20,
		});
		return { observer, bodies, lines, stamps };
	}

	test("a call whose verdict is send goes after the debounce, before its turn has ended; withhold sends nothing", async () => {
		const { observer, bodies } = rig();
		const sent = resultedCall();
		const withheld = resultedCall({
			detailVerdict: "withhold",
			detailInput: { file_path: "/secret/x" },
		});
		observer.onCallResulted(sent);
		observer.onCallResulted(withheld);
		expect(bodies).toHaveLength(0);
		await Bun.sleep(80);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.calls.map((c) => c.toolUseId)).toEqual([sent.toolUseId]);
		expect(JSON.stringify(bodies)).not.toContain("/secret/x");
		expect(bodies[0]?.calls[0]).toMatchObject({
			tool: "Bash",
			outcome: "unasked",
			turnActionId: "act-1",
			fromSubagent: false,
			outputTruncated: false,
		});
	});

	test("the default debounce is a second: a call is posted well inside 2 s of its result", () => {
		expect(FORK_TOOL_DETAIL_LIMITS.debounceMs).toBe(1000);
		expect(FORK_TOOL_DETAIL_LIMITS.debounceMs).toBeLessThan(2000);
	});

	test("a server that doesn't offer the feature gets nothing, at a call or at the turn's end", async () => {
		const { observer, bodies } = rig({ offered: false });
		observer.onCallResulted(resultedCall());
		observer.onTurnFinished({ actionId: "act-1", ended: "result", calls: [resultedCall()] });
		await Bun.sleep(60);
		expect(bodies).toEqual([]);
	});

	test("a bare observer (no gate given) observes nothing", () => {
		const bare = forkTurnObserver(SESSION);
		bare.onCallResulted(resultedCall());
		bare.onTurnFinished({ actionId: "a", ended: "result", calls: [resultedCall()] });
	});

	test("the turn's end sends what never resulted at once: no_result, or stopped when a person stopped the turn", async () => {
		const { observer, bodies } = rig({ debounceMs: 60_000 });
		const cut = resultedCall({ resulted: false, detailResult: null, detailResultBytes: 0 });
		observer.onTurnFinished({ actionId: "act-1", ended: "interrupted", calls: [cut] });
		await Bun.sleep(30);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.calls[0]).toMatchObject({ outcome: "stopped", output: null });
		const crashed = rig({ debounceMs: 60_000 });
		crashed.observer.onTurnFinished({ actionId: "a", ended: "fatal", calls: [cut] });
		await Bun.sleep(30);
		expect(crashed.bodies[0]?.calls[0]?.outcome).toBe("no_result");
	});

	test("a tool name outside the six reports as nothing; an MCP tool reports as mcp, never by name", () => {
		expect(toolCallReport(resultedCall({ name: "Agent" }), null)).toBeNull();
		expect(toolCallReport(resultedCall({ name: "mcp__secret-server__dump" }), null)?.tool).toBe(
			"mcp",
		);
		expect(
			JSON.stringify(toolCallReport(resultedCall({ name: "mcp__secret-server__dump" }), null)),
		).not.toContain("secret-server");
	});

	test("a cut result says so; a subagent's call says so", () => {
		const report = toolCallReport(
			resultedCall({
				detailResultBytes: 70_000,
				detailResult: "x".repeat(65_536),
				agentId: "sub-1",
			}),
			null,
		);
		expect(report?.outputTruncated).toBe(true);
		expect(report?.fromSubagent).toBe(true);
	});

	test("bodies stay under 240 KiB: 12 calls of 100 KiB give at least 5 bodies, none over the limit, none lost", async () => {
		const calls = Array.from({ length: 12 }, (_, i) =>
			resultedCall({
				toolUseId: `toolu_big${i}`,
				detailInput: { command: "y".repeat(40_000) },
				detailResult: "z".repeat(60_000),
				detailResultBytes: 60_000,
			}),
		);
		const { observer, bodies } = rig({ debounceMs: 60_000 });
		observer.onTurnFinished({ actionId: "a", ended: "result", calls });
		await Bun.sleep(60);
		expect(bodies.length).toBeGreaterThanOrEqual(5);
		for (const body of bodies) {
			expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(
				FORK_TOOL_DETAIL_LIMITS.batchBytes,
			);
		}
		expect(
			bodies
				.flatMap((b) => b.calls)
				.map((c) => c.toolUseId)
				.sort(),
		).toEqual(calls.map((c) => c.toolUseId).sort());
	});

	test("a queue that reaches 240 KiB is sent without waiting for the debounce", async () => {
		const { observer, bodies } = rig({ debounceMs: 60_000 });
		for (let i = 0; i < 5; i++) {
			observer.onCallResulted(
				resultedCall({ detailResult: "r".repeat(60_000), detailResultBytes: 60_000 }),
			);
		}
		await Bun.sleep(40);
		expect(bodies.length).toBeGreaterThanOrEqual(1);
	});

	test("one call too large for any body is dropped and counted; the others still go", () => {
		const big = toolCallReport(
			resultedCall({ detailResult: "\u0000".repeat(60_000), detailResultBytes: 60_000 }),
			null,
		);
		const small = toolCallReport(resultedCall(), null);
		const { bodies, dropped } = splitIntoBodies(
			[big, small, small].filter((r) => r !== null),
			40_000,
		);
		expect(dropped).toBe(1);
		expect(bodies.flat()).toHaveLength(2);
	});

	test("a failing send is counted in a line that names no input and no output, never thrown, and the next body goes", async () => {
		const { observer, lines } = rig({
			failWith: new Error("network down SENTINEL-IN-ERROR"),
			debounceMs: 5,
		});
		observer.onCallResulted(
			resultedCall({ detailInput: { command: "echo SECRET-COMMAND" }, detailResult: "SECRET-OUT" }),
		);
		await Bun.sleep(60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/1 tool call\(s\)/);
		expect(lines.join("\n")).not.toMatch(/SECRET|SENTINEL/);
	});

	test("a throwing send never escapes into the stream", async () => {
		const observer = forkTurnObserver(SESSION, {
			send: () => {
				throw new Error("sync throw");
			},
			serverHas: () => true,
			debounceMs: 5,
		});
		observer.onCallResulted(resultedCall());
		observer.onTurnFinished({ actionId: "a", ended: "result", calls: [] });
		await Bun.sleep(40);
	});
});

describe("the verdict comes from the intact input, never from what is sent (C-H3)", () => {
	const work = "/work/project";
	const rulePath = "/work/secret-area";
	const judge = createDetailJudge({
		cwd: work,
		excludesPath: (p) => p === rulePath || p.startsWith(`${rulePath}/`),
		excludeScope: () => ({ state: "ok", paths: [rulePath] }),
		realpath: async (p) => p,
	});

	test("a Write whose 200 KiB input names an excluded file_path after byte 16 KiB is withheld, and nothing is sent", async () => {
		const input = { content: "c".repeat(200 * 1024), file_path: `${rulePath}/key.txt` };
		expect(JSON.stringify(input).indexOf("file_path")).toBeGreaterThan(16 * 1024);
		const verdict = await judge("Write", input);
		expect(verdict).toBe("withhold");
		const bodies: ForkToolCallsReportBody[] = [];
		const observer = forkTurnObserver("s", {
			send: async (_id, body) => void bodies.push(body),
			serverHas: () => true,
			debounceMs: 5,
		});
		observer.onCallResulted(
			newToolCallRecord({
				toolUseId: "toolu_w",
				name: "Write",
				detailInput: input,
				resulted: true,
				detailVerdict: verdict,
			}),
		);
		await Bun.sleep(30);
		expect(bodies).toEqual([]);
	});

	test("a Bash whose 100 KiB command names a rule path past the cut, in any of its spellings, is withheld", async () => {
		const pad = "echo a; ".repeat(13_000);
		expect(pad.length).toBeGreaterThan(100 * 1024);
		for (const naming of [`${rulePath}/k`, "../secret-area/k"]) {
			expect(await judge("Bash", { command: `${pad}cat ${naming}` }), naming).toBe("withhold");
		}
		expect(await judge("Bash", { command: pad })).toBe("send");
	});

	test("a rule under the home directory is also named by ~ and $HOME", async () => {
		const { homedir } = await import("node:os");
		const homeRule = join(homedir(), ".secrets-area");
		const homeJudge = createDetailJudge({
			cwd: work,
			excludesPath: () => false,
			excludeScope: () => ({ state: "ok", paths: [homeRule] }),
			realpath: async (p) => p,
		});
		for (const naming of [
			`${homeRule}/k`,
			"~/.secrets-area/k",
			"$HOME/.secrets-area/k",
			"${HOME}/.secrets-area/k",
		]) {
			expect(await homeJudge("Bash", { command: `cat ${naming}` }), naming).toBe("withhold");
		}
		expect(await homeJudge("Bash", { command: "cat ~/other/k" })).toBe("send");
	});

	test("an input that isn't an object, or a path that isn't a string, is withheld", async () => {
		expect(await judge("Write", "just text")).toBe("withhold");
		expect(await judge("Read", { file_path: 42 })).toBe("withhold");
		expect(await judge("Bash", null)).toBe("withhold");
	});

	test("a symlink into an excluded path is withheld through its resolved path", async () => {
		const linked = createDetailJudge({
			cwd: work,
			excludesPath: (p) => p === rulePath || p.startsWith(`${rulePath}/`),
			excludeScope: () => ({ state: "ok", paths: [rulePath] }),
			realpath: async (p) =>
				p.startsWith(`${work}/link`) ? p.replace(`${work}/link`, rulePath) : p,
		});
		expect(await linked("Read", { file_path: `${work}/link/key.txt` })).toBe("withhold");
		expect(await linked("Read", { file_path: `${work}/plain.txt` })).toBe("send");
	});
});
