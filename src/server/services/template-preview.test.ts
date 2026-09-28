import { describe, expect, test } from "bun:test";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";

describe("normalizeTemplateInput — D5 Pattern A'", () => {
	test("an explicitly supplied non-launchable agentType passes through unchanged, not coerced to codex_cli", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating raw untrusted wire input
		const result = normalizeTemplateInput({ agentType: "copilot_cli" } as any);
		expect(result.agentType).toBe("copilot_cli");
		expect(result.agentType).not.toBe("codex_cli");
	});

	test("an absent agentType still defaults to codex_cli", () => {
		const result = normalizeTemplateInput({});
		expect(result.agentType).toBe("codex_cli");
	});

	test("an explicit launchable agentType is preserved", () => {
		const result = normalizeTemplateInput({ agentType: "claude_code" });
		expect(result.agentType).toBe("claude_code");
	});
});

describe("validateTemplateInput — D5 Pattern A'", () => {
	test("rejects a non-launchable agentType even once it's a recognized observed value", () => {
		const input = normalizeTemplateInput({
			name: "t",
			cwd: "/tmp",
			// biome-ignore lint/suspicious/noExplicitAny: simulating raw untrusted wire input
			agentType: "copilot_cli" as any,
		});
		const { errors } = validateTemplateInput(input);
		expect(errors).toContain("Agent type must be claude_code or codex_cli.");
	});

	test("accepts claude_code and codex_cli", () => {
		for (const agentType of ["claude_code", "codex_cli"] as const) {
			const input = normalizeTemplateInput({ name: "t", cwd: "/tmp", agentType });
			const { errors } = validateTemplateInput(input);
			expect(errors).not.toContain("Agent type must be claude_code or codex_cli.");
		}
	});
});
