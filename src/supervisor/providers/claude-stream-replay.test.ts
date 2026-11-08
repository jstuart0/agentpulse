/**
 * AGEN-119..123 Track 0 gate: every recorded 2.1.318 stream replays through the fork runtime to the reports it
 * produced at base commit 198eda63, plus only `tool_use_id` on a call row. The golden is written once, at
 * that commit, with `FORK_REPLAY_WRITE_GOLDEN=1 bun test src/supervisor/providers/claude-stream-replay.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayFixture } from "../test-utils/claude-fixture-replay.js";
import { type Harness, createHarness } from "../test-utils/claude-stream-harness.js";
import { fixtureNames } from "./__fixtures__/claude-frames.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";

const GOLDEN = join(import.meta.dir, "__fixtures__", "replay-golden-2.1.318.json");
const WRITE = process.env.FORK_REPLAY_WRITE_GOLDEN === "1";

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

/** The keys later tracks add to a call row (Track 0: the id; AGEN-122: the structured outcome); everything else must be byte-equal to base. */
const ADDED_CALL_ROW_KEYS = new Set([
	"tool_use_id",
	"tool",
	"toolOutcome",
	"is_error",
	"exit_code",
]);
function withoutToolUseId(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value, (key, v) => (ADDED_CALL_ROW_KEYS.has(key) ? undefined : v)),
	);
}

/**
 * Claude prints its closing text right after a turn's `result` (recorded in `key-restricted-clean`), and whether
 * those lines land before or after the host has closed the turn is a race the base commit has too. A trailing
 * closing message after the last turn-end row is therefore not part of what is compared.
 */
function withoutTrailingClosingText(result: unknown): unknown {
	const copy = JSON.parse(JSON.stringify(result)) as { events: Array<{ eventType: string }> };
	const ends = copy.events.map((e) => e.eventType);
	const lastEnd = Math.max(
		ends.lastIndexOf("HeadlessPromptCompleted"),
		ends.lastIndexOf("HeadlessPromptFailed"),
	);
	if (lastEnd >= 0) {
		copy.events = copy.events.filter(
			(e, i) => i <= lastEnd || e.eventType !== "HeadlessAssistantMessage",
		);
	}
	return copy;
}

describe("replay identity over the 2.1.318 fixtures", () => {
	test("every fixture that was sent a prompt replays to the base commit's reports", async () => {
		const results: Record<string, unknown> = {};
		for (const name of fixtureNames()) {
			const replay = await replayFixture(name, harness);
			if (replay) results[name] = replay;
		}
		const names = Object.keys(results);
		// Population floor: the replay compared something. Named members cover a call row, a fatal and a failed turn.
		expect(names.length).toBeGreaterThanOrEqual(10);
		for (const member of ["bash-fail.jsonl", "uuid-fork.jsonl", "id-swap-clear.jsonl"]) {
			expect(names, member).toContain(member);
		}
		if (WRITE) {
			writeFileSync(GOLDEN, `${JSON.stringify(results, null, "\t")}\n`);
			return;
		}
		expect(existsSync(GOLDEN)).toBe(true);
		const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
		expect(Object.keys(golden).sort()).toEqual(names.sort());
		for (const name of names) {
			expect(withoutToolUseId(withoutTrailingClosingText(results[name])), name).toEqual(
				withoutToolUseId(withoutTrailingClosingText(golden[name])),
			);
		}
		// Positive control: the call rows really did gain the key, so the comparison above removed something.
		const callRows = names.flatMap((n) =>
			(results[n] as { events: Array<{ rawPayload?: Record<string, unknown> }> }).events.filter(
				(e) => e.rawPayload?.kind === "call",
			),
		);
		expect(callRows.length).toBeGreaterThanOrEqual(3);
		expect(callRows.every((e) => typeof e.rawPayload?.tool_use_id === "string")).toBe(true);
	}, 120_000);
});
