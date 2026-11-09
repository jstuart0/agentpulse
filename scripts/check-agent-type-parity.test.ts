import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReadSite, checkAgentTypeParity } from "./check-agent-type-parity.js";
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

	test("extractUnion pulls a literal-union type's members (allowUnderscore for snake_case)", () => {
		const content = 'export type AgentType = "claude_code" | "codex_cli";\n';
		expect(extractUnion(content, "AgentType", { allowUnderscore: true })).toEqual([
			"claude_code",
			"codex_cli",
		]);
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

// AGEN-141: "opencode" is an observed, non-launchable type that has to appear at every
// site. These run the guard's own check over the real files, then over a copy with the
// MCP edit reverted (a positive control first, so a failure below means the guard saw it).
describe("check-agent-type-parity — opencode (AGEN-141)", () => {
	const ROOT = new URL("..", import.meta.url).pathname;
	const real: ReadSite = (rel) => readFileSync(join(ROOT, rel), "utf8");
	const without =
		(rel: string, edit: (text: string) => string): ReadSite =>
		(requested) =>
			requested === rel ? edit(real(requested)) : real(requested);

	test("the real tree passes and opencode is observed, not launchable", () => {
		const result = checkAgentTypeParity(real);
		expect(result.errors).toEqual([]);
		expect(result.observed).toContain("opencode");
		expect(result.launchable).not.toContain("opencode");
		expect(result.sites.length).toBe(6);
	});

	test("opencode missing from the MCP zod enum fails", () => {
		const result = checkAgentTypeParity(
			without("packages/agentpulse-mcp/src/enums.ts", (t) => t.replace(/\s*"opencode",/, "")),
		);
		expect(result.errors.some((e) => e.includes("OBSERVED_AGENT_TYPE_ENUM"))).toBe(true);
	});

	test("opencode missing from the MCP AgentType union fails", () => {
		const result = checkAgentTypeParity(
			without("packages/agentpulse-mcp/src/types.ts", (t) => t.replace(' | "opencode";', ";")),
		);
		expect(result.errors.some((e) => e.includes("types.ts AgentType"))).toBe(true);
	});

	test("opencode added to the launchable list fails the subset check", () => {
		const result = checkAgentTypeParity(
			without("src/shared/constants.ts", (t) =>
				t.replace(
					'LAUNCHABLE_AGENT_TYPES = ["claude_code", "codex_cli"]',
					'LAUNCHABLE_AGENT_TYPES = ["claude_code", "codex_cli", "opencode"]',
				),
			),
		);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});
