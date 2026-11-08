/**
 * AGEN-119..123 Track 0, S0: the recorded Claude Code 2.1.319 streams (interrupts, subagents, MCP) are
 * converted, scrubbed and replayable. Replayed with every option off they behave exactly as the fork does
 * today: a subagent's lines are a peer turn, an interrupt's result is a failed turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { replayFixture } from "../test-utils/claude-fixture-replay.js";
import { type Harness, createHarness } from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR_2_1_319 as DIR,
	claudeManifest,
	fixtureNames,
	outLines,
	readClaudeFixture,
} from "./__fixtures__/claude-frames.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";

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

const NAMED = [
	"int-bash-key",
	"int-sub-key",
	"int-sub-helper",
	"s1-key",
	"s1-helper",
	"s2-key-bgoff",
	"s2-key-bgon",
	"s5-general-key",
	"s5b-custom-helper",
	"m1-base-key",
	"m1-base-helper",
	"m1-allowrule-key",
	"m1-usercfg-strict-helper",
	"m1-usercfg-nostrict-helper",
	// AGEN-120: the second measurement's Agent-call runs (G5, G6, G7).
	"g5-norule-allow-key",
	"g5-rule-allow-key",
	"g5-rule-allow-helper",
	"g5-rule-deny-key",
	"g6-rule-allowall-key",
	"g6-rule-denynested-key",
	"g7-with-helper",
];

describe("claude 2.1.319 fixtures: scrub and shape", () => {
	test("exactly the named runs are committed, each in the manifest and the other way round", () => {
		const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
		expect(onDisk.sort()).toEqual(fixtureNames(DIR).sort());
		expect(onDisk.sort()).toEqual(NAMED.map((n) => `${n}.jsonl`).sort());
	});

	test("nothing of the machine, the person or a credential is in any file", () => {
		for (const name of readdirSync(DIR)) {
			const text = readFileSync(join(DIR, name), "utf8");
			for (const forbidden of [
				"sk-ant",
				"/Users/",
				"/private/",
				"claude-501",
				"jaystuart",
				"/opt/homebrew",
			]) {
				expect(text, `${name}: ${forbidden}`).not.toContain(forbidden);
			}
			expect(text, name).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/i);
			expect(text, name).not.toMatch(/d73d6bb9/);
		}
	});

	test("every line parses with a direction and a frame object, and the version is 2.1.319", () => {
		for (const name of fixtureNames(DIR)) {
			const lines = readClaudeFixture(name, DIR);
			expect(lines.length).toBeGreaterThan(5);
			for (const line of lines) {
				expect(["in", "out"]).toContain(line.dir);
				expect(typeof line.frame).toBe("object");
			}
			const init = lines.find((l) => l.dir === "out" && l.frame.subtype === "init")?.frame;
			expect(init?.claude_code_version, name).toBe("2.1.319");
		}
	});

	test("the manifest's restricted flag agrees with the init Claude printed", () => {
		let checked = 0;
		for (const [file, meta] of Object.entries(claudeManifest(DIR))) {
			const init = readClaudeFixture(file, DIR).find(
				(l) => l.dir === "out" && l.frame.subtype === "init",
			)?.frame;
			if (!init) continue;
			expect(meta.restricted, file).toBe(!("messaging_socket_path" in init));
			checked++;
		}
		expect(checked).toBe(NAMED.length);
		expect(new Set(Object.values(claudeManifest(DIR)).map((m) => m.restricted))).toEqual(
			new Set([true, false]),
		);
	});

	test("what the plan leans on is there: subagent lines with agent_id, an interrupt's result, an MCP request", () => {
		const s1 = outLines("s1-key", DIR);
		expect(s1.some((m) => typeof m.agent_id === "string" && m.parent_tool_use_id)).toBe(true);
		expect(s1.some((m) => m.type === "system" && m.subtype === "task_started")).toBe(true);
		const interrupt = outLines("int-bash-key", DIR).find((m) => m.type === "result");
		expect(interrupt).toMatchObject({
			subtype: "error_during_execution",
			is_error: true,
			terminal_reason: "aborted_tools",
		});
		const mcpRequests = ["m1-base-key", "m1-base-helper", "m1-allowrule-key"].flatMap((n) =>
			outLines(n, DIR).filter(
				(m) => m.type === "control_request" && String(m.request?.tool_name).startsWith("mcp__"),
			),
		);
		expect(mcpRequests.length).toBeGreaterThanOrEqual(1);
		expect(mcpRequests[0]?.request?.mcp_server).toBeDefined();
	});
});

describe("claude 2.1.319 fixtures replayed with every option off", () => {
	test("each fixture that was sent a prompt ends the way today's fork ends it", async () => {
		const seen: Record<string, string> = {};
		for (const name of fixtureNames(DIR)) {
			const replay = await replayFixture(name, harness, { dir: DIR });
			if (!replay) continue;
			const last = replay.outcomes.at(-1) as { ok?: boolean; code?: string };
			seen[name] = last.ok ? "completed" : String(last.code);
		}
		expect(Object.keys(seen).length).toBeGreaterThanOrEqual(12);
		// A subagent's lines are a stranger's turn to a fork with subagents off.
		for (const name of [
			"s1-key.jsonl",
			"s1-helper.jsonl",
			"int-sub-key.jsonl",
			"int-sub-helper.jsonl",
			"s5-general-key.jsonl",
			"s5b-custom-helper.jsonl",
			"s2-key-bgoff.jsonl",
		]) {
			expect(seen[name], name).toBe("fatal");
		}
		// The interrupt's result is, today, a failed turn; the next prompt is answered.
		expect(seen["int-bash-key.jsonl"]).toBe("completed");
		// MCP runs that used no subagent complete.
		for (const name of ["m1-base-key.jsonl", "m1-base-helper.jsonl", "m1-allowrule-key.jsonl"]) {
			expect(seen[name], name).toBe("completed");
		}
	}, 120_000);
});
