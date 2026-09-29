/**
 * Phase 5 ([plan+] F35): per-agent AUTH_STEP table, the Codex numbered step
 * list, and the D22 lastEventLine helper. Pure functions — no DOM.
 */
import { describe, expect, test } from "bun:test";
import { AUTH_STEP, codexSetupSteps, lastEventLine } from "./setup-steps.js";

describe("AUTH_STEP", () => {
	test("claude_code returns the env-var export step", () => {
		const step = AUTH_STEP.claude_code("ap_test123", false);
		expect(step).not.toBeNull();
		expect(step?.command).toContain("export AGENTPULSE_API_KEY=");
		expect(step?.command).toContain("ap_test123");
		expect(step?.windowsCommand).toBeUndefined();
	});

	test("codex_cli and copilot_cli return the hook-auth-header command with the key single-quoted", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			expect(step).not.toBeNull();
			expect(step?.command).toContain("~/.agentpulse/hook-auth-header");
			expect(step?.command).toContain("'ap_test123'");
			expect(step?.command).toContain("umask 077");
		}
	});

	test("disableAuth:true gives null for all three agents", () => {
		expect(AUTH_STEP.claude_code("ap_test123", true)).toBeNull();
		expect(AUTH_STEP.codex_cli("ap_test123", true)).toBeNull();
		expect(AUTH_STEP.copilot_cli("ap_test123", true)).toBeNull();
	});

	test("the PowerShell auth variant contains icacls and Authorization: Bearer, with the key in single quotes", () => {
		const step = AUTH_STEP.codex_cli("ap_test123", false);
		expect(step?.windowsCommand).toContain("icacls");
		expect(step?.windowsCommand).toContain("Authorization: Bearer ap_test123");
	});

	test("the auth step includes curl 7.55+ for codex and copilot", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			expect(step?.note).toContain("curl 7.55+");
		}
	});
});

describe("codexSetupSteps", () => {
	test("4 numbered steps with the trust text verbatim", () => {
		const steps = codexSetupSteps("Last Codex event: 3 min ago");
		expect(steps).toHaveLength(4);
		expect(steps[2]).toBe(
			"Open Codex and run `/hooks`, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Re-trust if you change the AgentPulse URL or port.",
		);
		expect(steps[3]).toBe("Last Codex event: 3 min ago");
	});

	test("(r3, F56) step 1 text contains 'Back up your existing file first' and not 'agentpulse-bak'", () => {
		const steps = codexSetupSteps("");
		expect(steps[0]).toContain("Back up your existing file first");
		expect(steps[0]).not.toContain("agentpulse-bak");
	});
});

describe("lastEventLine (D22)", () => {
	test("ends with '· in proj' when cwd is set", () => {
		const line = lastEventLine({ at: new Date().toISOString(), cwd: "/w/proj" });
		expect(line.endsWith("· in proj")).toBe(true);
		expect(line).toContain("Last Codex event:");
	});

	test("with no events, includes the TUI-scope wording when execIndexed:false", () => {
		const line = lastEventLine({ at: null, execIndexed: false });
		expect(line).toContain("No Codex events yet");
		expect(line).toContain("interactive Codex sessions only");
	});

	test("with no events and execIndexed omitted/true, omits the TUI-scope wording", () => {
		const line = lastEventLine({ at: null });
		expect(line).toContain("No Codex events yet");
		expect(line).not.toContain("interactive Codex sessions only");
	});
});
