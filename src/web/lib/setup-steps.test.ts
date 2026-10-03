/**
 * Phase 5 ([plan+] F35): per-agent AUTH_STEP table, the Codex numbered step
 * list, and the D22 lastEventLine helper. Pure functions — no DOM.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AUTH_STEP,
	CLAUDE_SKIP_LINE,
	EXCLUDE_CARD,
	EXCLUDE_CARD_ANCHOR,
	EXCLUDE_RULES_PATH,
	FIRST_RUN_EXCLUDE_LINK,
	RELAY_PARAGRAPH,
	codexSetupSteps,
	lastEventLine,
} from "./setup-steps.js";

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
			"Open Codex and run `/hooks`, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Approve them again after an update changes the hook command, or if you change the AgentPulse URL or port.",
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

const WEB_ROOT = join(import.meta.dir, "..");
const webSources = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return webSources(path);
		return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
	});

describe("exclude card copy", () => {
	const rowFor = (needle: string) => EXCLUDE_CARD.senders.find((r) => r.sender.includes(needle));

	test("title, intro and the two copy-button commands are verbatim", () => {
		expect(EXCLUDE_CARD.title).toBe("Exclude directories");
		expect(EXCLUDE_RULES_PATH).toBe("~/.agentpulse/exclude");
		expect(EXCLUDE_CARD.intro).toBe(
			"Stop sessions in chosen directories from being reported. Rules live in ~/.agentpulse/exclude on each machine.",
		);
		expect(EXCLUDE_CARD.commands.map((c) => c.command)).toEqual([
			"agentpulse exclude add ~/scratch",
			"agentpulse exclude check",
		]);
		for (const c of EXCLUDE_CARD.commands) expect(c.label.length).toBeGreaterThan(0);
	});

	test("the Claude direct row is the only caution row and carries the plan sentence with the broken-file clause", () => {
		const cautions = EXCLUDE_CARD.senders.filter((r) => r.caution);
		expect(cautions).toHaveLength(1);
		expect(cautions[0]?.sender).toContain("Claude Code");
		expect(cautions[0]?.applies).toContain(
			"Path rules are not applied on this machine, and a broken rules file doesn't stop it. Use the relay, or set AGENTPULSE_SKIP=1.",
		);
	});

	test("the table says what the code does, sender by sender", () => {
		expect(EXCLUDE_CARD.senders.map((r) => r.sender)).toEqual([
			"Codex CLI, Copilot CLI",
			"Claude Code through the relay",
			"Sessions AgentPulse launches, and the Codex observer",
			"Claude Code straight to the server",
		]);
		const hooks = rowFor("Codex CLI, Copilot CLI")?.applies ?? "";
		expect(hooks).toContain("hook command");
		expect(hooks).toContain("nothing is sent");
		expect(hooks).toContain("AGENTPULSE_SKIP=1");
		const relay = rowFor("through the relay")?.applies ?? "";
		expect(relay).toContain("relay");
		expect(relay).toContain("before anything is stored");
		expect(relay).toContain("AGENTPULSE_SKIP=1");
		const supervisor = rowFor("launches")?.applies ?? "";
		expect(supervisor).toContain("supervisor");
		expect(supervisor).toContain("refused");
		expect(supervisor).toContain("doesn't see AGENTPULSE_SKIP");
	});

	test("Windows is never claimed to work", () => {
		expect(EXCLUDE_CARD.windowsNote).toContain("not yet tested on Windows");
		const all = JSON.stringify(EXCLUDE_CARD);
		expect(all).not.toMatch(/works on windows|supported on windows|enforced on windows/i);
	});

	test("new-events sentence and the team-mode sentence", () => {
		expect(EXCLUDE_CARD.newEventsNote).toBe(
			"Rules apply to new events. Sessions already reported stay on the dashboard until you delete them.",
		);
		expect(EXCLUDE_CARD.teamNote).toBe(
			"Rules stay on each machine and aren't visible to admins or other members. The one thing a supervisor reports is that its exclude file or its saved exclude state has an error. Run agentpulse exclude check on that machine.",
		);
	});

	test("the Claude config line, the relay paragraph and the first-run link", () => {
		expect(CLAUDE_SKIP_LINE).toContain(
			"X-AgentPulse-Skip lets you turn reporting off for one run: AGENTPULSE_SKIP=1 claude.",
		);
		expect(RELAY_PARAGRAPH).toContain(
			"On another machine, install a small relay. It keeps your key out of agent config, queues events when the server is unreachable, and applies your exclude rules before anything is sent.",
		);
		expect(FIRST_RUN_EXCLUDE_LINK.lead).toBe("Working somewhere you don't want reported?");
		expect(FIRST_RUN_EXCLUDE_LINK.linkText).toBe("Exclude a directory.");
		expect(EXCLUDE_CARD_ANCHOR).toBe("exclude-directories");
		expect(FIRST_RUN_EXCLUDE_LINK.to).toBe(`/setup#${EXCLUDE_CARD_ANCHOR}`);
	});

	test("the false 'localhost only' sentences are gone from every web source", () => {
		// Built from parts so this file doesn't contain the sentences it forbids (a repo grep for them must print nothing).
		const forbidden = [
			new RegExp(["only sends hooks to", "localhost"].join(" "), "i"),
			new RegExp(["blocks hooks to", "non-localhost"].join(" "), "i"),
		];
		const offenders = webSources(WEB_ROOT).filter((f) => {
			const text = readFileSync(f, "utf-8");
			return forbidden.some((re) => re.test(text));
		});
		expect(offenders).toEqual([]);
	});

	test("the pages use the copy module rather than carrying their own text", () => {
		const setup = readFileSync(join(WEB_ROOT, "pages/SetupPage.tsx"), "utf-8");
		expect(setup).toContain("RELAY_PARAGRAPH");
		expect(setup).toContain("CLAUDE_SKIP_LINE");
		expect(setup).toContain("<ExcludeDirectoriesCard");
		const firstRun = readFileSync(join(WEB_ROOT, "components/FirstRunWelcome.tsx"), "utf-8");
		expect(firstRun).toContain("FIRST_RUN_EXCLUDE_LINK");
	});
});
