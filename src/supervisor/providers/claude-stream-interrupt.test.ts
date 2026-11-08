/**
 * AGEN-119: Stop turn on the fork runtime. `interruptTurn` ends what a turn is doing with Claude's own
 * interrupt and keeps the process, the runtime and the session. Whether a turn "was stopped" is decided from the
 * `result` it ends with, never from the flag alone (F38). A fake `claude` is driven with the recorded
 * `int-bash-key` (2.1.319) and `cancel-interrupt` (2.1.318) lines; streams a test writes by hand are tagged
 * `[synthetic]` in their name. No test signals a process it did not start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	CLAUDE_INTERRUPT_RESULT_WAIT_MS,
	INTERRUPTED_TERMINAL_REASONS,
	STOPPED_BEFORE_SEND,
	TURN_DIDNT_STOP,
	TURN_ERRORED_AFTER_STOP,
	TURN_STOPPED_BY_PERSON,
} from "../../shared/stop-turn.js";
import { turnsOf } from "../test-utils/claude-fixture-replay.js";
import {
	FAST_TIMINGS,
	type Harness,
	INIT,
	assistantToolUse,
	createHarness,
	recordingPort,
	resultOk,
	toolResult,
	until,
} from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR_2_1_319,
	type RecordedLine,
	readClaudeFixture,
} from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import {
	ClaudePromptRefusal,
	_resetClaudeStreamForTest,
	disposeAllClaudeStreamRuntimes,
	interruptClaudeStreamSession,
} from "./claude-stream.js";
import type { ObservedTurn } from "./fork-turn-observer.js";

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
	for (const h of harnesses.splice(0)) {
		h.assertCleanWire();
		expect(h.guard.refused).toEqual([]);
		h.cleanup();
	}
});

const prompt = async (rt: Awaited<ReturnType<Harness["start"]>>, id = "a1") => {
	rt.beginSettle();
	rt.settled();
	return await rt.sendPrompt("go", id);
};

/** The recorded interrupted turn: the lines before the interrupt are the turn, the lines after it are what Claude does when interrupted. */
function recordedInterrupt(name: string, dir?: string) {
	const lines: RecordedLine[] = readClaudeFixture(name, dir);
	const at = lines.findIndex(
		(l) =>
			l.dir === "in" &&
			l.frame.type === "control_request" &&
			l.frame.request?.subtype === "interrupt",
	);
	expect(at).toBeGreaterThan(0);
	const before = turnsOf(lines.slice(0, at))[0] ?? [];
	const NOT_REPLAYED = new Set(["control_response", "control_request", "command_lifecycle"]);
	const after: Record<string, unknown>[] = [];
	for (const line of lines.slice(at + 1)) {
		if (line.dir === "in") break;
		const type = line.frame.type as string;
		if (NOT_REPLAYED.has(type)) continue;
		after.push(
			JSON.parse(
				JSON.stringify(line.frame).replaceAll(
					/"session_id":"[0-9a-f-]{36}"/g,
					'"session_id":"$SESSION"',
				),
			),
		);
		if (type === "result") break;
	}
	return { before, after };
}

describe("a recorded interrupt ends the turn as a person's stop and leaves the runtime alive", () => {
	test("int-bash-key (2.1.319): the interrupted turn", async () => {
		const { before, after } = recordedInterrupt("int-bash-key", CLAUDE_FIXTURE_DIR_2_1_319);
		const finished: ObservedTurn[] = [];
		const h = harness({
			turns: [[...before, { hold: true }]],
			onInterrupt: { frames: after },
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port, onTurnFinished: (t) => void finished.push(t) });
		const sent = await prompt(rt);
		await until(() => rt.turnRunning && h.fake.userLines() >= 1, "the turn to start");
		await Bun.sleep(150);
		const result = await rt.interruptTurn("a1");
		expect(result).toEqual({ status: "interrupted" });
		expect(await sent.done).toEqual({
			ok: false,
			code: "interrupted",
			error: TURN_STOPPED_BY_PERSON,
		});
		// The turn ended as a stop and the process is the same, alive, and was never signalled.
		expect(rt.state).toBe("live");
		expect(h.guard.sent).toEqual([]);
		const end = h.events.find((e) => e.eventType === "HeadlessPromptFailed");
		expect(end?.content).toBe(TURN_STOPPED_BY_PERSON);
		expect(end?.rawPayload).toMatchObject({ status: "interrupted", claudeStreamRuntime: true });
		expect(h.events.some((e) => e.eventType === "HeadlessPromptCompleted")).toBe(false);
		expect(port.calls).toContain("fenceTurn");
		expect(port.calls).not.toContain("liftTurnFence");
		expect(port.calls).not.toContain("fence");
		expect(port.calls).not.toContain("dispose");
		await until(() => finished.length === 1, "the observer");
		expect(finished[0]).toMatchObject({ actionId: "a1", ended: "interrupted" });
		// A later prompt is accepted by the same process.
		const next = await rt.sendPrompt("again", "a2");
		expect(await next.done).toEqual({ ok: true });
	});

	test("cancel-interrupt (2.1.318): the held call row comes out once, after the result, as part of the turn's end", async () => {
		const { before, after } = recordedInterrupt("cancel-interrupt");
		const h = harness({ turns: [[...before, { hold: true }]], onInterrupt: { frames: after } });
		const rt = await h.start();
		const sent = await prompt(rt);
		await Bun.sleep(200);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "interrupted" });
		expect(await sent.done).toMatchObject({ ok: false, code: "interrupted" });
		const rows = h.events.filter((e) => e.rawPayload?.kind === "call");
		expect(rows.length).toBeLessThanOrEqual(1);
		const order = h.events.map((e) => e.eventType);
		if (rows.length === 1) {
			expect(order.indexOf("HeadlessStatus")).toBeLessThan(order.indexOf("HeadlessPromptFailed"));
		}
	});

	test("the recorded interrupt reasons are the ones the host accepts (aborted_tools and aborted_streaming)", () => {
		expect(INTERRUPTED_TERMINAL_REASONS).toEqual(["aborted_tools", "aborted_streaming"]);
	});

	test("[synthetic] an interrupt while Claude streams text (aborted_streaming, stop_reason null) is a stop", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "assistant",
							session_id: "$SESSION",
							message: {
								role: "assistant",
								model: "m",
								content: [{ type: "text", text: "a long essay" }],
							},
						},
					},
					{ hold: true },
				],
			],
			onInterrupt: {
				frames: [
					{
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						stop_reason: null,
						terminal_reason: "aborted_streaming",
						session_id: "$SESSION",
					},
				],
			},
		});
		const rt = await h.start();
		const sent = await prompt(rt);
		await Bun.sleep(100);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "interrupted" });
		expect(await sent.done).toMatchObject({ ok: false, code: "interrupted" });
	});
});

describe("'interrupted' is decided from the result, not the flag (F38)", () => {
	test("[synthetic] a natural result after the interrupt was requested completes the turn and the interrupt reports it did not interrupt", async () => {
		const h = harness({
			turns: [[INIT, { hold: true }]],
			onInterrupt: {
				frames: [
					{
						type: "result",
						subtype: "success",
						is_error: false,
						terminal_reason: "completed",
						session_id: "$SESSION",
						user_message_uuids: ["$UUID"],
					},
				],
			},
		});
		const rt = await h.start();
		const sent = await prompt(rt);
		await Bun.sleep(100);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		expect(await sent.done).toEqual({ ok: true });
		expect(h.events.some((e) => e.eventType === "HeadlessPromptCompleted")).toBe(true);
		expect(h.events.some((e) => e.rawPayload?.status === "interrupted")).toBe(false);
	});

	test("[synthetic] an errored result with an unrecorded terminal_reason is the failed-turn words, not a stop", async () => {
		const h = harness({
			turns: [[INIT, { hold: true }]],
			onInterrupt: {
				frames: [
					{
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						terminal_reason: "something_new",
						session_id: "$SESSION",
					},
				],
			},
		});
		const rt = await h.start();
		const sent = await prompt(rt);
		await Bun.sleep(100);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		expect(await sent.done).toEqual({
			ok: false,
			code: "turn_error",
			error: TURN_ERRORED_AFTER_STOP,
		});
		const end = h.events.find((e) => e.eventType === "HeadlessPromptFailed");
		expect(end?.rawPayload?.status).toBe("turn_error");
	});

	test("[synthetic] an aborted result with NO interrupt requested is an ordinary failed turn (the flag is half the rule)", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "result",
							subtype: "error_during_execution",
							is_error: true,
							terminal_reason: "aborted_tools",
							session_id: "$SESSION",
							user_message_uuids: ["$UUID"],
						},
					},
				],
			],
		});
		const rt = await h.start();
		const sent = await prompt(rt);
		expect(await sent.done).toMatchObject({ ok: false, code: "turn_error" });
	});

	test("an interrupt for another turn, or when none runs, does nothing and the next turn is untouched", async () => {
		const h = harness({
			turns: [
				[INIT, resultOk],
				[INIT, resultOk],
			],
		});
		const rt = await h.start();
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		const sent = await prompt(rt, "a1");
		expect(await sent.done).toEqual({ ok: true });
		// Claimed after its target finished: the next turn must not be stopped by it.
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		const next = await rt.sendPrompt("again", "a2");
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		expect(await next.done).toEqual({ ok: true });
		expect(await interruptClaudeStreamSession("no-such-session", "a1")).toEqual({
			status: "not_interrupted",
		});
	});

	test("[synthetic] a repeated press shares the first answer and sends one interrupt", async () => {
		const h = harness({ turns: [[INIT, { hold: true }]] });
		const rt = await h.start();
		const sent = await prompt(rt);
		await Bun.sleep(100);
		const [a, b] = await Promise.all([rt.interruptTurn("a1"), rt.interruptTurn("a1")]);
		expect(a).toEqual({ status: "interrupted" });
		expect(b).toEqual(a);
		await sent.done;
		expect(
			h.fake.log().filter((e) => e.ev === "control_request" && e.subtype === "interrupt"),
		).toHaveLength(1);
	});
});

describe("an interrupt before the prompt is sent cancels the send (F37)", () => {
	test("[synthetic] during the pre-send checks: no user line, the prompt fails interrupted_before_send, one end event, no idle report", async () => {
		const h = harness({ turns: [[INIT, resultOk]] });
		const slowAgents: NonNullable<Parameters<Harness["options"]>[0]>["listAgents"] = async () => {
			await Bun.sleep(150);
			return {
				ok: true,
				entries: [{ pid: h.fake.pid(), sessionId: "22222222-2222-4222-8222-222222222222" }],
			};
		};
		const rt = await h.start({ listAgents: slowAgents });
		rt.beginSettle();
		rt.settled();
		const userLinesBefore = h.fake.userLines();
		const states = h.states.length;
		const sending = rt.sendPrompt("go", "a1");
		const refused = sending.then(
			() => null,
			(error: unknown) => error,
		);
		await Bun.sleep(30);
		const interrupted = await rt.interruptTurn("a1");
		expect(interrupted).toEqual({ status: "interrupted", beforeSend: true });
		const error = await refused;
		expect(error).toBeInstanceOf(ClaudePromptRefusal);
		expect((error as ClaudePromptRefusal).kind).toBe("interrupted_before_send");
		expect((error as ClaudePromptRefusal).message).toBe(STOPPED_BEFORE_SEND);
		expect(h.fake.userLines()).toBe(userLinesBefore);
		const ends = h.events.filter((e) => e.eventType === "HeadlessPromptFailed");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.rawPayload).toMatchObject({
			status: "interrupted",
			code: "interrupted_before_send",
		});
		// No idle report (B2-N2): the server ends the turn from the event above.
		expect(h.states.length).toBe(states);
		expect(rt.turnRunning).toBe(false);
		// The runtime is fine: the next prompt runs.
		const next = await rt.sendPrompt("again", "a2");
		expect(await next.done).toEqual({ ok: true });
	});

	test("[synthetic] a prompt that fails another way settles the interrupt as not interrupted", async () => {
		const h = harness({ turns: [[INIT, resultOk]] });
		let failing = false;
		const rt = await h.start({
			listAgents: async () => {
				if (!failing) {
					return {
						ok: true,
						entries: [{ pid: h.fake.pid(), sessionId: "22222222-2222-4222-8222-222222222222" }],
					};
				}
				await Bun.sleep(80);
				return { ok: false, why: "no" } as never;
			},
		});
		failing = true;
		rt.beginSettle();
		rt.settled();
		const sending = rt.sendPrompt("go", "a1").catch((error: unknown) => error);
		await Bun.sleep(20);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "not_interrupted" });
		expect(await sending).toBeInstanceOf(ClaudePromptRefusal);
	});
});

describe("a Claude that ignores the interrupt", () => {
	test("the production wait is 30 s", () => {
		expect(CLAUDE_INTERRUPT_RESULT_WAIT_MS).toBe(30_000);
	});

	test("[synthetic] after the wait the interrupt fails, the fence is lifted, the prompt keeps running and a later result still settles it", async () => {
		const h = harness({ turns: [[INIT, { hold: true }]], onInterrupt: "ignore" });
		const port = recordingPort();
		const rt = await h.start({ approvals: port, interruptWaitMs: 150 });
		const sent = await prompt(rt);
		await Bun.sleep(80);
		const result = await rt.interruptTurn("a1");
		expect(result).toEqual({ status: "didnt_stop" });
		expect(TURN_DIDNT_STOP).toContain("30 seconds");
		expect(port.calls.filter((c) => c === "fenceTurn")).toHaveLength(1);
		expect(port.calls.filter((c) => c === "liftTurnFence")).toHaveLength(1);
		// The turn is still the running one and nothing was signalled.
		expect(rt.turnRunning).toBe(true);
		expect(h.guard.sent).toEqual([]);
		await rt.stop({ ...FAST_TIMINGS });
		expect(await sent.done).toMatchObject({ ok: false, code: "stopped" });
	});
});

describe("after an interrupt that did not take", () => {
	test("[synthetic] a call that results after the wait gets its row at once: the flag that held rows back was cleared", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					assistantToolUse("t1", "Bash", { command: "ls" }),
					{ delay: 700 },
					toolResult("t1"),
					{ hold: true },
				],
			],
			onInterrupt: "ignore",
		});
		const rt = await h.start({ interruptWaitMs: 150 });
		await prompt(rt);
		await Bun.sleep(100);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "didnt_stop" });
		// The turn is still running and the result lands after the wait: its row is live, not held for the turn's end.
		await until(() => h.events.some((e) => e.rawPayload?.kind === "call"), "the live call row");
		expect(rt.turnRunning).toBe(true);
	});

	test("[synthetic] 'Try again' works: a second press after a failed one sends a fresh interrupt", async () => {
		const h = harness({ turns: [[INIT, { hold: true }]], onInterrupt: "ignore" });
		const rt = await h.start({ interruptWaitMs: 120 });
		await prompt(rt);
		await Bun.sleep(60);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "didnt_stop" });
		expect(await rt.interruptTurn("a1")).toEqual({ status: "didnt_stop" });
		expect(
			h.fake.log().filter((e) => e.ev === "control_request" && e.subtype === "interrupt"),
		).toHaveLength(2);
	});
});

describe("Stop turn does not disturb End session", () => {
	test("[synthetic] a Stop during an interrupt in flight settles both without a second turn_end", async () => {
		const h = harness({ turns: [[INIT, { hold: true }]], onInterrupt: "ignore" });
		const rt = await h.start({ interruptWaitMs: 2_000 });
		const sent = await prompt(rt);
		await Bun.sleep(80);
		const pending = rt.interruptTurn("a1");
		await Bun.sleep(30);
		await rt.stop({ ...FAST_TIMINGS });
		expect(await pending).toEqual({ status: "not_interrupted" });
		expect(await sent.done).toMatchObject({ ok: false, code: "stopped" });
	});
});
