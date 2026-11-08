/**
 * AGEN-123: what a call ran never leaves in an event. Every recorded stream (2.1.318 and 2.1.319) is
 * replayed with a sentinel planted in every tool input and every tool result, and no event the runtime
 * reported (any row kind, any end event) and no state report contains it. The scan first proves it saw the
 * sentinel where it belongs: in the records handed to the observer, which is the only place it may be.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { replayFixture } from "../test-utils/claude-fixture-replay.js";
import { type Harness, createHarness } from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR,
	CLAUDE_FIXTURE_DIR_2_1_319,
	type RecordedLine,
	fixtureNames,
} from "./__fixtures__/claude-frames.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import type { ToolCallRecord } from "./fork-tool-record.js";

const SENTINEL = "SENTINEL_9f3c2a71e0b44d";

const harnesses: Harness[] = [];
const harness = (config: Parameters<typeof createHarness>[0]) => {
	const h = createHarness(config);
	harnesses.push(h);
	return h;
};
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

/** Every string inside a tool_use input, and every tool_result's content, now holds the sentinel. */
function plant(lines: RecordedLine[]): RecordedLine[] {
	const taint = (value: unknown): unknown => {
		if (typeof value === "string") return `${value}${SENTINEL}`;
		if (Array.isArray(value)) return value.map(taint);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, taint(v)]));
		}
		return value;
	};
	return lines.map((line) => {
		if (line.dir !== "out") return line;
		const frame = JSON.parse(JSON.stringify(line.frame)) as Record<string, any>;
		const content = frame.message?.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.type === "tool_use" && block.input && typeof block.input === "object") {
					block.input = { ...(taint(block.input) as object), planted: SENTINEL };
				}
				if (block?.type === "tool_result") {
					block.content =
						typeof block.content === "string"
							? `${block.content}${SENTINEL}`
							: [{ type: "text", text: `result ${SENTINEL}` }];
				}
			}
		}
		return { ...line, frame };
	});
}

describe("a sentinel in every input and result", () => {
	test("is in the records the observer gets and in no event or state report, over every recorded stream", async () => {
		const seen: ToolCallRecord[] = [];
		let replayed = 0;
		let withCalls = 0;
		for (const dir of [CLAUDE_FIXTURE_DIR, CLAUDE_FIXTURE_DIR_2_1_319]) {
			for (const name of fixtureNames(dir)) {
				const before = seen.length;
				const result = await replayFixture(name, harness, {
					dir,
					transform: plant,
					extra: {
						onCallResulted: (call) => void seen.push(call),
						onTurnFinished: (turn) => void seen.push(...turn.calls),
						detailJudge: async () => "send",
					},
				});
				if (!result) continue;
				replayed++;
				if (seen.length > before) withCalls++;
				const everything = JSON.stringify({ events: result.events, states: result.states });
				expect(everything, `${dir}/${name}`).not.toContain(SENTINEL);
				// A population floor per stream with events: the scan looked at real reports.
				expect(result.events.length, name).toBeGreaterThan(0);
			}
		}
		expect(replayed).toBeGreaterThanOrEqual(20);
		expect(withCalls).toBeGreaterThanOrEqual(5);
		// The sentinel did reach the records, which is where it belongs.
		expect(seen.some((c) => JSON.stringify(c.detailInput).includes(SENTINEL))).toBe(true);
		expect(seen.some((c) => (c.detailResult ?? "").includes(SENTINEL))).toBe(true);
	}, 180_000);
});
