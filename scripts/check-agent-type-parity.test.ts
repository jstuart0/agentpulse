import { describe, expect, test } from "bun:test";
import {
	extractConstTuple,
	extractUnion,
	extractZodEnum,
	isSubsetOf,
	sameSet,
} from "./lib/parity-utils.js";

describe("check-agent-type-parity extraction helpers — synthetic content", () => {
	test("extractConstTuple pulls the tuple's string literals", () => {
		const content = 'export const AGENT_TYPES = ["claude_code", "codex_cli"] as const;\n';
		expect(extractConstTuple(content, "AGENT_TYPES")).toEqual(["claude_code", "codex_cli"]);
	});

	test("extractZodEnum pulls a z.enum(...) call's string literals", () => {
		const content =
			'export const OBSERVED_AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli"]);\n';
		expect(extractZodEnum(content, "OBSERVED_AGENT_TYPE_ENUM")).toEqual([
			"claude_code",
			"codex_cli",
		]);
	});

	test("extractUnion pulls a literal-union type's members", () => {
		const content = 'export type AgentType = "claude_code" | "codex_cli";\n';
		expect(extractUnion(content, "AgentType")).toEqual(["claude_code", "codex_cli"]);
	});

	test("a deliberately introduced divergence is detected by sameSet", () => {
		const canonical = extractConstTuple(
			'export const AGENT_TYPES = ["claude_code", "codex_cli"] as const;\n',
			"AGENT_TYPES",
		);
		// Simulates a drifted site — someone renamed "codex_cli" without
		// updating the canonical list.
		const drifted = extractConstTuple(
			'export const AGENT_TYPES = ["claude_code", "codex_cli_v2"] as const;\n',
			"AGENT_TYPES",
		);
		expect(sameSet(canonical, drifted)).toBe(false);
	});

	test("sameSet is order-independent and length-sensitive", () => {
		expect(sameSet(["a", "b"], ["b", "a"])).toBe(true);
		expect(sameSet(["a", "b"], ["a"])).toBe(false);
	});

	test("isSubsetOf detects a launchable value missing from the observed set", () => {
		expect(isSubsetOf(["claude_code", "codex_cli"], ["claude_code", "codex_cli"])).toBe(true);
		expect(isSubsetOf(["claude_code", "copilot_cli"], ["claude_code", "codex_cli"])).toBe(false);
	});
});
