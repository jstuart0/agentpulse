/**
 * D35 (F24/Phase 7 window start): the Ask system prompt tells the model
 * which agents it might see sessions from. Copilot CLI is a third one as
 * of Phase 6 — the prompt text hasn't been updated to say so.
 *
 * RED until context-builder.ts's ASK_SYSTEM_PROMPT mentions Copilot.
 */
import { describe, expect, test } from "bun:test";
import { ASK_SYSTEM_PROMPT } from "./context-builder.js";

describe("ASK_SYSTEM_PROMPT — three-agent prose (D35)", () => {
	test("mentions Claude Code, Codex, and Copilot", () => {
		expect(ASK_SYSTEM_PROMPT).toContain("Claude Code");
		expect(ASK_SYSTEM_PROMPT).toContain("Codex");
		expect(ASK_SYSTEM_PROMPT).toMatch(/Copilot/i);
	});
});
