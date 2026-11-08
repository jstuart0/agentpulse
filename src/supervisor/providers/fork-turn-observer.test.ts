/**
 * AGEN-119..123 Track 0, S3: the turn observer is called exactly once per turn from every way a turn can end,
 * a call's result is announced once its row is queued, and a result that arrives after an interrupt was asked
 * for waits for the turn's real outcome. A fake `claude` built from the recorded lines drives each ending; no
 * real Claude is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import type { ToolCallRecord } from "./fork-tool-record.js";
import {
	type ForkTurnObserver,
	type ObservedTurn,
	forkTurnObserver,
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
