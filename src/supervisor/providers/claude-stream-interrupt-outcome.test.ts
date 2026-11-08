/**
 * Cross-track (AGEN-119 with AGEN-122): the recorded interrupted turn emits its call's row as `stopped`, in
 * words that say so, and a `stopped` row is not a `failed` one, which is all the classifier counts as a tool
 * failure. Replays the 2.1.319 `int-bash-key` recording against the fake `claude`; no real Claude.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { turnsOf } from "../test-utils/claude-fixture-replay.js";
import { type Harness, createHarness } from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR_2_1_319,
	type RecordedLine,
	readClaudeFixture,
} from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";

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

describe("an interrupted turn's call row", () => {
	test("int-bash-key (2.1.319): toolOutcome stopped, stopped words, never failed", async () => {
		const { before, after } = recordedInterrupt("int-bash-key", CLAUDE_FIXTURE_DIR_2_1_319);
		const h = harness({ turns: [[...before, { hold: true }]], onInterrupt: { frames: after } });
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "a1");
		await Bun.sleep(200);
		expect(await rt.interruptTurn("a1")).toEqual({ status: "interrupted" });
		await sent.done;
		const rows = h.events.filter((e) => e.rawPayload?.kind === "call");
		expect(rows.length).toBeGreaterThanOrEqual(1);
		for (const row of rows) {
			expect(row.rawPayload?.toolOutcome).toBe("stopped");
			expect(row.content).toContain("stopped when you stopped the turn");
			// The classifier counts only `failed`.
			expect(row.rawPayload?.toolOutcome).not.toBe("failed");
		}
	});
});
