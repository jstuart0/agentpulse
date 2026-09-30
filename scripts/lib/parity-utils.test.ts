import { describe, expect, test } from "bun:test";
import {
	extractKeyValueListBlock,
	extractQuotedListBlocks,
	extractQuotedTokens,
	extractUnion,
} from "./parity-utils.js";

describe("extractQuotedTokens / extractQuotedListBlocks / extractKeyValueListBlock — strict PascalCase, no snake_case (the hook-event guard's own callers)", () => {
	test("extractQuotedTokens rejects a snake_case token", () => {
		expect(extractQuotedTokens('"claude_code", "SessionStart"')).toEqual(["SessionStart"]);
	});

	test("extractQuotedListBlocks rejects a snake_case token inside a block", () => {
		const content = 'const EVENTS=("SessionStart" "claude_code" "Stop")';
		const [block] = extractQuotedListBlocks(content, /EVENTS=\(/, ")");
		expect(block).toEqual(["SessionStart", "Stop"]);
	});

	test("extractKeyValueListBlock (install-local.ps1's Codex hash-array shape) rejects a snake_case value", () => {
		const content =
			'$codexHooks = @{ event = "SessionStart" }, @{ event = "claude_code" }, @{ event = "Stop" } Set-JsonFile -Path (Join-Path $codexDir x)';
		const events = extractKeyValueListBlock(
			content,
			/\$codexHooks = @\{/,
			"Set-JsonFile -Path (Join-Path $codexDir",
		);
		expect(events).toEqual(["SessionStart", "Stop"]);
	});
});

describe("extractUnion — strict by default, snake_case only with allowUnderscore", () => {
	test("default (no opts) rejects a snake_case member", () => {
		const content = 'export type CodexEvent = "SessionStart" | "claude_code";';
		expect(extractUnion(content, "CodexEvent")).toEqual(["SessionStart"]);
	});

	test("allowUnderscore:true accepts a snake_case member", () => {
		const content = 'export type AgentType = "claude_code" | "codex_cli";';
		expect(extractUnion(content, "AgentType", { allowUnderscore: true })).toEqual([
			"claude_code",
			"codex_cli",
		]);
	});
});
