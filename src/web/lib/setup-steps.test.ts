/**
 * Phase 5 ([plan+] F35): per-agent AUTH_STEP table, the Codex numbered step
 * list, and the D22 lastEventLine helper. Pure functions — no DOM.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_STEP, codexSetupSteps, lastEventLine } from "./setup-steps.js";

const WINDOWS_GOLDEN = join(import.meta.dir, "../../../scripts/__golden__/windows-auth-step.ps1");

/** The exact shell bash-isms banned from a POSIX sh snippet, matching
 * src/shared/hook-command.test.ts's "posix sh compatibility" suite. */
function assertPosixSh(command: string) {
	// `[[ ` (bash conditional, always followed by whitespace) is banned;
	// `[[:space:]]` (a POSIX bracket-expression named class) is not a
	// bash-ism and must not false-positive.
	expect(command).not.toMatch(/\[\[\s/);
	expect(command).not.toContain("$'");
	expect(command).not.toMatch(/\bfunction\s/);
	expect(command).not.toMatch(/\bsource\s/);
	expect(command).not.toMatch(/\w+=\(/); // bash array assignment: name=(...)
	expect(command).not.toMatch(/[^=!<>]==[^=]/); // POSIX sh test/[ use =, not ==
}

describe("AUTH_STEP", () => {
	test("claude_code (AGEN-49): reads the key at a hidden prompt and writes it to ~/.agentpulse/env, never the rc file", () => {
		const step = AUTH_STEP.claude_code("ap_test123", false);
		expect(step).not.toBeNull();
		const command = step?.command ?? "";
		expect(command).not.toContain("ap_test123");
		expect(command).not.toMatch(/read -rs/);
		expect(command).toContain("stty -echo");
		expect(command).toContain("IFS= read -r k;");
		expect(command).toContain("stty -g");
		expect(command).toContain("can only contain");
		expect(command).toContain("No API key entered");
		expect(command).toContain("export AGENTPULSE_API_KEY=");
		expect(command).toContain('f="$d/env"');
		expect(command).toContain(".agentpulse/env");
		expect(command).toContain(".zshrc");
		expect(command).toContain(".bashrc");
		expect(step?.windowsCommand).toBeUndefined();
		assertPosixSh(command);
	});

	test("codex_cli and copilot_cli (AGEN-49): read the key at a hidden prompt, never embedded literally in the POSIX command", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			expect(step).not.toBeNull();
			const command = step?.command ?? "";
			expect(command).not.toContain("ap_test123");
			expect(command).not.toMatch(/read -rs/);
			expect(command).toContain("stty -echo");
			expect(command).toContain("IFS= read -r k;");
			expect(command).toContain("stty -g");
			expect(command).toContain("can only contain");
			expect(command).toContain("No API key entered");
			expect(command).toContain("d=~/.agentpulse");
			expect(command).toContain('f="$d/hook-auth-header"');
			expect(command).toContain("umask 077");
			expect(command).toContain('"$key"');
			assertPosixSh(command);
		}
	});

	test("codex_cli and copilot_cli (AGEN-49): the PowerShell variant reads the key at a hidden, secure prompt too — the literal key is absent", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			const win = step?.windowsCommand ?? "";
			expect(win).not.toContain("ap_test123");
			expect(win).toContain("Read-Host");
			expect(win).toContain("-AsSecureString");
			expect(win).toContain("SecureStringToBSTR");
			expect(win).toContain("PtrToStringBSTR");
			// The unmanaged BSTR copy is freed once converted, not left dangling.
			expect(win).toContain("ZeroFreeBSTR");
			expect(win).toContain("Authorization: Bearer $key");
		}
	});

	test("codex_cli and copilot_cli (AGEN-49): the key variable never becomes an external command's argument — only Set-Content -Value (in-process) touches it", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			const win = step?.windowsCommand ?? "";
			// `&` (the call operator) invokes an external program with the
			// rest of the statement as its argv — Windows' analogue of a key
			// showing up in `ps`/Task Manager. fsutil is invoked this way
			// (hard-link check) but never with $key/$secure/$bstr in its args.
			const callOperatorLines = win
				.split(";")
				.filter((segment) => /&\s/.test(segment) || /Start-Process/.test(segment));
			for (const segment of callOperatorLines) {
				expect(segment).not.toMatch(/\$(key|secure|bstr)\b/);
			}
			// Every other place the key value appears is Set-Content -Value,
			// an in-process .NET call, not a child process invocation.
			const keyUses = win.match(/\$key\b/g) ?? [];
			expect(keyUses.length).toBeGreaterThan(0);
		}
	});

	test("F249 (codex r2 D38): the POSIX command checks the parent directory for a symlink BEFORE mkdir -p, not just the final file", () => {
		const step = AUTH_STEP.codex_cli("ap_test123", false);
		const command = step?.command ?? "";
		expect(command).toContain('if [ -L "$d" ]');
		expect(command).toContain('elif [ -L "$f" ]');
		// Order matters: the parent check has to run before mkdir -p, since
		// mkdir -p on an already-existing symlinked path silently succeeds.
		const parentCheckIdx = command.indexOf('if [ -L "$d" ]');
		const mkdirIdx = command.indexOf("mkdir -p");
		expect(parentCheckIdx).toBeGreaterThan(-1);
		expect(mkdirIdx).toBeGreaterThan(-1);
		expect(parentCheckIdx).toBeLessThan(mkdirIdx);
		// Still writes via a temp file + atomic replace (F207), not in place.
		expect(command).toContain('t="$f.$$.tmp"');
		expect(command).toContain('mv -f "$t" "$f"');
	});

	test("F249 (codex r2 D38): the PowerShell command checks both the parent directory and the file for a reparse point, and writes via temp-file + Move-Item", () => {
		const step = AUTH_STEP.codex_cli("ap_test123", false);
		const windowsCommand = step?.windowsCommand ?? "";
		expect(windowsCommand).toContain("function ApTestReparse");
		expect(windowsCommand).toContain(".LinkType");
		expect(windowsCommand).toContain("ReparsePoint");
		// Both the parent ($d) and the file ($f) are checked.
		expect(windowsCommand).toContain("ApTestReparse $d");
		expect(windowsCommand).toContain("ApTestReparse $f");
		// Temp-file + Move-Item, not a direct Set-Content at the final path.
		expect(windowsCommand).toContain("Move-Item -Force -Path $t -Destination $f");
		expect(windowsCommand).not.toMatch(/Set-Content -NoNewline -Path \$f\b/);
	});

	test("AGEN-49: the PowerShell command also checks the file for a hard link, same ordering as install-local.ps1's New-ApHookAuthHeaderFile", () => {
		const step = AUTH_STEP.codex_cli("ap_test123", false);
		const windowsCommand = step?.windowsCommand ?? "";
		expect(windowsCommand).toContain("function ApTestHardLink");
		expect(windowsCommand).toContain("fsutil hardlink list");
		expect(windowsCommand).toContain("ApTestHardLink $f");
		// Hard-link check runs before the reparse-point check for the file,
		// same order as New-ApHookAuthHeaderFile.
		const hardLinkIdx = windowsCommand.indexOf("ApTestHardLink $f");
		const fileReparseIdx = windowsCommand.indexOf("ApTestReparse $f");
		expect(hardLinkIdx).toBeGreaterThan(-1);
		expect(fileReparseIdx).toBeGreaterThan(-1);
		expect(hardLinkIdx).toBeLessThan(fileReparseIdx);
		// Both the directory and the file get an ACL narrowed to the
		// current user — (OI)(CI)F for the directory, (R,W) for the file.
		expect(windowsCommand).toContain("(OI)(CI)F");
		expect(windowsCommand).toContain("(R,W)");
	});

	test("disableAuth:true gives null for all three agents", () => {
		expect(AUTH_STEP.claude_code("ap_test123", true)).toBeNull();
		expect(AUTH_STEP.codex_cli("ap_test123", true)).toBeNull();
		expect(AUTH_STEP.copilot_cli("ap_test123", true)).toBeNull();
	});

	test("the PowerShell auth variant contains icacls and an Authorization: Bearer header referencing the read-in key, never a literal", () => {
		const step = AUTH_STEP.codex_cli("ap_test123", false);
		expect(step?.windowsCommand).toContain("icacls");
		expect(step?.windowsCommand).toContain("Authorization: Bearer $key");
		expect(step?.windowsCommand).not.toContain("Authorization: Bearer ap_test123");
	});

	test("the auth step includes curl 7.55+ for codex and copilot", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const step = AUTH_STEP[agent]("ap_test123", false);
			expect(step?.note).toContain("curl 7.55+");
		}
	});

	test("AGEN-49/M2: the rendered windowsCommand matches the checked-in golden byte-for-byte", async () => {
		// scripts/test-install-local.ps1's Windows CI job has no bun/node —
		// it can't render this string itself, so a golden fixture is the
		// only way it gets a real PowerShell parser ([scriptblock]::Create)
		// over the actual generated text. This test is the drift detector:
		// if buildCommandHookAuthStep's windowsCommand ever changes, the
		// golden must be regenerated in the same commit or this fails.
		// windowsCommand is identical for codex_cli and copilot_cli (same
		// generator, key is never embedded either way).
		const step = AUTH_STEP.codex_cli("ignored", false);
		const golden = await readFile(WINDOWS_GOLDEN, "utf8");
		expect(`${step?.windowsCommand}\n`).toBe(golden);
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
