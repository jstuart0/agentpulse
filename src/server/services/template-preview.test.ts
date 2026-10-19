import { describe, expect, test } from "bun:test";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";

describe("normalizeTemplateInput — D5 Pattern A'", () => {
	test("an explicitly supplied non-launchable agentType passes through unchanged, not coerced to codex_cli", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating raw untrusted wire input
		const result = normalizeTemplateInput({ agentType: "copilot_cli" } as any);
		expect(result.agentType as string).toBe("copilot_cli");
		expect(result.agentType as string).not.toBe("codex_cli");
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

describe("validateTemplateInput — the working directory is the target machine's to check", () => {
	const warningsFor = (cwd: string) =>
		validateTemplateInput(
			normalizeTemplateInput({
				name: "t",
				cwd,
				agentType: "claude_code",
				baseInstructions: "b",
				taskPrompt: "p",
			}),
		).warnings;

	test("a directory that exists on this server's disk and one that doesn't get the same answer: this disk says nothing about the machine the launch goes to", () => {
		const present = warningsFor(process.cwd());
		const absent = warningsFor("/definitely/not/a/real/directory/for/agentpulse");
		expect(absent).toEqual(present);
		for (const warning of [...present, ...absent]) {
			expect(warning).not.toMatch(/exist/i);
		}
	});

	test("the checks that don't depend on the machine are still made", () => {
		const input = normalizeTemplateInput({ name: "t", cwd: "/tmp", agentType: "claude_code" });
		const { errors, warnings } = validateTemplateInput(input);
		expect(errors).toEqual([]);
		expect(warnings).toContain("Base instructions are empty.");
		expect(warnings).toContain("Task prompt is empty.");
		expect(
			validateTemplateInput(
				normalizeTemplateInput({ name: "t", cwd: "/a/../b", agentType: "claude_code" }),
			).errors,
		).toContain("Working directory may not contain '..' segments.");
	});
});
