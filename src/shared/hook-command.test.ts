/**
 * Phase 5 (D12/D13): the shared hook-command generators. Pure-function tests
 * — no network, no filesystem. scripts/codex-hook-command.test.ts covers
 * actually executing the generated command; scripts/hook-command-parity.test.ts
 * covers the bash/PowerShell transcriptions matching this module byte for
 * byte.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WRITE_CAPABLE_RIGHTS_MASK, WRITE_CAPABLE_RIGHT_NAMES } from "./exclude-rules.js";
import {
	CODEX_EVENT_ORDER,
	COPILOT_EVENT_ORDER,
	INSTALLER_SNIPPET_PLACEHOLDERS,
	assertValidHookBaseUrl,
	buildBashExcludeScript,
	buildBashExcludeScriptForInstaller,
	buildBashExcludeSnippet,
	buildBashHookCommand,
	buildCodexHooksFile,
	buildCopilotHooksFile,
	buildPowerShellExcludeScript,
	buildPowerShellExcludeSnippet,
	buildPowerShellHookCommand,
	excludeScriptHeaderHash,
} from "./hook-command.js";
import { EXCLUDE_MAX_RULES, EXCLUDE_SCRIPT_RELATIVE_PATH } from "./hook-headers.js";

const BASE = "http://localhost:4000";
/** The single printf the hook command is allowed: it builds the trim set (space, tab, CR, LF) for the skip check. */
const TRIM_SET_PRINTF = "$(printf ' \\t\\r\\n.')";

describe("buildBashHookCommand — relay mode", () => {
	test("has no Authorization header and no hook-auth-header reference", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).not.toContain("Authorization");
		expect(cmd).not.toContain("hook-auth-header");
	});

	test("targets the right URL, event and agent header", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "sessionStart",
		});
		expect(cmd).toContain(`'${BASE}/api/v1/hooks?event=sessionStart'`);
		expect(cmd).toContain("-H 'X-Agent-Type: copilot_cli'");
	});
});

describe("buildBashHookCommand — direct mode", () => {
	test('the key never enters argv: references hook-auth-header via -H "@$f" and has no $(cat', () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('-H "@$f"');
		expect(cmd).toContain("$HOME/.agentpulse/hook-auth-header");
		expect(cmd).not.toContain("$(cat");
	});
});

describe("buildBashHookCommand — byte stability (trust-hash-stability property)", () => {
	test("two calls with the same input produce byte-identical output", () => {
		const opts = {
			baseUrl: BASE,
			direct: true,
			agent: "codex_cli",
			event: "SessionStart",
		} as const;
		const a = buildBashHookCommand(opts);
		const b = buildBashHookCommand(opts);
		expect(a).toBe(b);
	});
});

describe("buildBashHookCommand — D13 shape (r6 detached)", () => {
	test('contains mktemp, a backgrounded subshell with all streams redirected, and --data-binary "@$t"', () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain("mktemp");
		expect(cmd).toContain("</dev/null >/dev/null 2>&1 &");
		expect(cmd).toContain('--data-binary "@$t"');
		expect(cmd).not.toContain("--data-binary @-");
		expect(cmd).not.toContain("$(cat");
	});

	test("ends with the literal D13 tail", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd.endsWith(") </dev/null >/dev/null 2>&1 & exit 0")).toBe(true);
	});

	test('no-stdout shape: only non-curl stdin/stdout operation is `cat > "$t"` — no echo/printf/tee/jq, no bare cat', () => {
		for (const agent of ["codex_cli", "copilot_cli"]) {
			for (const direct of [false, true]) {
				const cmd = buildBashHookCommand({ baseUrl: BASE, direct, agent, event: "Stop" });
				expect(cmd).not.toMatch(/\becho\b/);
				// the one printf builds the whitespace set the skip check trims, in a
				// command substitution (a built-in in every shell the agent may use)
				expect(cmd.replace(TRIM_SET_PRINTF, "")).not.toMatch(/\bprintf\b/);
				expect(cmd.split(TRIM_SET_PRINTF).length - 1).toBe(1);
				expect(cmd).not.toMatch(/\btee\b/);
				expect(cmd).not.toMatch(/\bjq\b/);
				// every `cat` must be immediately followed by a redirect (`cat > "$t"`)
				const bareCat = cmd.match(/\bcat\b(?!\s*>)/g);
				expect(bareCat).toBeNull();
			}
		}
	});
});

describe("buildBashHookCommand — posix sh compatibility (no bash-isms)", () => {
	test("generated command has no [[, $'...', function/source keywords, array assignment, or == comparison", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			for (const direct of [false, true]) {
				const cmd = buildBashHookCommand({ baseUrl: BASE, direct, agent, event: "Stop" });
				// `[[ ` (bash conditional, always followed by whitespace) is banned;
				// `[[:space:]]` (a POSIX bracket-expression named class, used inside
				// grep -o here) is not a bash-ism and must not false-positive.
				expect(cmd).not.toMatch(/\[\[\s/);
				expect(cmd).not.toContain("$'");
				expect(cmd).not.toMatch(/\bfunction\s/);
				expect(cmd).not.toMatch(/\bsource\s/);
				expect(cmd).not.toMatch(/\w+=\(/); // bash array assignment: name=(...)
				expect(cmd).not.toMatch(/[^=!<>]==[^=]/); // POSIX sh test/[ use =, not ==
			}
		}
	});
});

describe("buildBashHookCommand — Codex native-coverage marker (cross-campaign, event-dedup D12/D19)", () => {
	test("codex_cli commands include the marker snippet; copilot_cli commands don't", () => {
		const codex = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const copilot = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "agentStop",
		});
		expect(codex).toContain("codex-native");
		expect(copilot).not.toContain("codex-native");
	});

	test("marker write happens before the curl invocation, inside the subshell", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const markerIdx = cmd.indexOf("codex-native");
		const curlIdx = cmd.indexOf("curl -sS");
		expect(markerIdx).toBeGreaterThan(-1);
		expect(curlIdx).toBeGreaterThan(-1);
		expect(markerIdx).toBeLessThan(curlIdx);
		// both must be inside the backgrounded subshell, i.e. after the opening "( "
		const subshellStart = cmd.indexOf("( ");
		expect(subshellStart).toBeGreaterThan(-1);
		expect(subshellStart).toBeLessThan(markerIdx);
	});

	test("uses $HOME, not $AGENTPULSE_DIR or $CODEX_HOME, for the marker path", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('"$HOME/.agentpulse/codex-native"');
		expect(cmd).not.toContain("AGENTPULSE_DIR");
		expect(cmd).not.toContain("CODEX_HOME");
	});
});

describe("buildBashHookCommand / buildPowerShellHookCommand — base URL validation (F41)", () => {
	const badUrls = [
		"http://localhost:4000'; rm -rf /",
		'http://localhost:4000"',
		"http://localhost:4000$(whoami)",
		"http://localhost:4000`whoami`",
		"http://localhost:4000 evil",
		"http://localhost:4000\nrm -rf /",
		"http://localhost:4000/path",
		"not-a-url",
	];

	for (const baseUrl of badUrls) {
		test(`buildBashHookCommand throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() =>
				buildBashHookCommand({ baseUrl, direct: false, agent: "codex_cli", event: "Stop" }),
			).toThrow();
		});
		test(`buildPowerShellHookCommand throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() =>
				buildPowerShellHookCommand({ baseUrl, direct: false, agent: "codex_cli", event: "Stop" }),
			).toThrow();
		});
		test(`assertValidHookBaseUrl throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() => assertValidHookBaseUrl(baseUrl)).toThrow();
		});
	}

	const goodUrls = [
		"http://localhost:4000",
		"https://agentpulse.example.com",
		"https://agentpulse.example.com:8443",
		"http://127.0.0.1:3000",
		"http://[::1]:4000",
	];
	for (const baseUrl of goodUrls) {
		test(`accepts ${baseUrl}`, () => {
			expect(() => assertValidHookBaseUrl(baseUrl)).not.toThrow();
		});
	}
});

describe("buildPowerShellHookCommand — marker extraction runs inside Start-Job, not on the synchronous parent path (never executed)", () => {
	test("the codex_cli marker snippet appears AFTER Start-Job in the generated text, not before it", () => {
		const cmd = buildPowerShellHookCommand({
			baseUrl: "http://localhost:4000",
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		const startJobIdx = cmd.indexOf("Start-Job");
		const markerIdx = cmd.indexOf("session_id");
		expect(startJobIdx).toBeGreaterThan(-1);
		expect(markerIdx).toBeGreaterThan(-1);
		expect(markerIdx).toBeGreaterThan(startJobIdx);
	});

	test("the marker snippet reads the temp file itself ([IO.File]::ReadAllText($t)), not the parent-scope $raw variable", () => {
		const cmd = buildPowerShellHookCommand({
			baseUrl: "http://localhost:4000",
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain("[IO.File]::ReadAllText($t)");
		// The parent-scope $raw is still used, but only for the synchronous
		// stdin-drain + temp-file write (D13) — never re-read for the marker.
		const markerSection = cmd.slice(cmd.indexOf("Start-Job"));
		expect(markerSection).not.toMatch(/\[regex\]::Match\(\$raw,/);
	});

	test("only the synchronous stdin-drain + temp-file write happen before Start-Job", () => {
		const cmd = buildPowerShellHookCommand({
			baseUrl: "http://localhost:4000",
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		const beforeJob = cmd.slice(0, cmd.indexOf("Start-Job"));
		expect(beforeJob).toContain("[Console]::In.ReadToEnd()");
		expect(beforeJob).toContain("[IO.File]::WriteAllText($t, $raw)");
		expect(beforeJob).not.toContain("session_id");
		expect(beforeJob).not.toContain("codex-native");
	});

	test("copilot_cli carries no marker snippet at all, before or after Start-Job", () => {
		const cmd = buildPowerShellHookCommand({
			baseUrl: "http://localhost:4000",
			direct: true,
			agent: "copilot_cli",
			event: "postToolUse",
		});
		expect(cmd).not.toContain("session_id");
		expect(cmd).not.toContain("codex-native");
	});
});

describe("hook file sizes stay small (an approval screen shows the whole command; Windows caps a command line at 8,191 characters)", () => {
	test("a Codex hooks file is at most 12 commands of the size limit", () => {
		for (const direct of [false, true]) {
			expect(buildCodexHooksFile({ baseUrl: BASE, direct }).length).toBeLessThan(12 * 2000 + 4000);
		}
	});

	test("a Copilot bash-only hooks file is at most 10 commands of the size limit", () => {
		for (const direct of [false, true]) {
			expect(buildCopilotHooksFile({ baseUrl: BASE, direct }).length).toBeLessThan(
				10 * 2000 + 2000,
			);
		}
	});
});

describe("command sizes with a realistic long server address", () => {
	// A 60-character https host with a port, the kind a company deployment has.
	const LONG_BASE = "https://agentpulse.platform-observability.internal.example.test:8443";
	/** What cmd.exe will not exceed on a command line: the one hard limit that applies to a hook string on Windows. */
	const CMD_EXE_LIMIT = 8191;
	const DESIGN_BUDGET = 2000; // the shell command's budget with the short address (ours, to keep it readable)

	test("the address is long enough to mean something", () => {
		expect(LONG_BASE.length).toBeGreaterThanOrEqual(60);
		assertValidHookBaseUrl(LONG_BASE);
	});

	test("every shell command fits cmd.exe's limit with the long address, and exceeds its own budget only by the address's extra length, once per place the address appears", () => {
		const extra = LONG_BASE.length - BASE.length;
		for (const agent of ["codex_cli", "copilot_cli"]) {
			for (const direct of [false, true]) {
				const cmd = buildBashHookCommand({ baseUrl: LONG_BASE, direct, agent, event: "Stop" });
				const places = cmd.split(LONG_BASE).length - 1;
				expect(places, `${agent} direct=${direct}`).toBeGreaterThanOrEqual(1);
				expect(cmd.length).toBeLessThan(CMD_EXE_LIMIT);
				expect(cmd.length, `${agent} direct=${direct}`).toBeLessThanOrEqual(
					DESIGN_BUDGET + places * extra,
				);
			}
		}
	});

	test("every PowerShell command fits cmd.exe's limit with the long address (never executed)", () => {
		for (const agent of ["codex_cli", "copilot_cli"]) {
			for (const direct of [false, true]) {
				const cmd = buildPowerShellHookCommand({
					baseUrl: LONG_BASE,
					direct,
					agent,
					event: "Stop",
				});
				expect(cmd.length, `${agent} direct=${direct}`).toBeLessThan(CMD_EXE_LIMIT);
			}
		}
	});

	test("the hooks files with the long address stay within their commands' budgets", () => {
		const extra = LONG_BASE.length - BASE.length;
		for (const direct of [false, true]) {
			const codex = buildCodexHooksFile({ baseUrl: LONG_BASE, direct });
			expect(codex.length).toBeLessThan(12 * (DESIGN_BUDGET + 2 * extra) + 4000);
			const copilot = buildCopilotHooksFile({ baseUrl: LONG_BASE, direct });
			expect(copilot.length).toBeLessThan(10 * (DESIGN_BUDGET + 2 * extra) + 2000);
		}
	});
});

describe("buildCodexHooksFile (D12)", () => {
	test("all 12 CodexEvent members are present, no matcher key anywhere", () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		const parsed = JSON.parse(text);
		expect(Object.keys(parsed.hooks).sort()).toEqual([...CODEX_EVENT_ORDER].sort());
		expect(text).not.toContain('"matcher"');
	});

	test("every handler is command + async:false + timeout:1", () => {
		const parsed = JSON.parse(buildCodexHooksFile({ baseUrl: BASE, direct: true }));
		for (const event of CODEX_EVENT_ORDER) {
			const handler = parsed.hooks[event][0].hooks[0];
			expect(handler.type).toBe("command");
			expect(handler.async).toBe(false);
			expect(handler.timeout).toBe(1);
			expect(typeof handler.command).toBe("string");
		}
	});

	test("no http type anywhere", () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		expect(text).not.toContain('"type": "http"');
		expect(text).not.toContain('"type":"http"');
	});

	test('serialized with JSON.stringify(x, null, 2) + "\\n" — trailing newline, two-space indent', () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		expect(text.endsWith("\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
		expect(text).toContain('\n  "hooks"');
	});

	test("byte-stable across repeated calls", () => {
		const opts = { baseUrl: BASE, direct: true };
		expect(buildCodexHooksFile(opts)).toBe(buildCodexHooksFile(opts));
	});

	test("keys are emitted in CODEX_EVENT_ORDER", () => {
		const parsed = JSON.parse(buildCodexHooksFile({ baseUrl: BASE, direct: false }));
		expect(Object.keys(parsed.hooks)).toEqual([...CODEX_EVENT_ORDER]);
	});
});

describe("buildCopilotHooksFile (D8/D13, Phase 7)", () => {
	test("all 10 CopilotEvent members are present, deliberately excludes preToolUse/permissionRequest", () => {
		const text = buildCopilotHooksFile({ baseUrl: BASE, direct: false });
		const parsed = JSON.parse(text);
		expect(Object.keys(parsed.hooks).sort()).toEqual([...COPILOT_EVENT_ORDER].sort());
		expect(Object.keys(parsed.hooks)).not.toContain("preToolUse");
		expect(Object.keys(parsed.hooks)).not.toContain("permissionRequest");
	});

	test("version:1, every handler is type:command with a bash string and timeoutSec:5", () => {
		const parsed = JSON.parse(buildCopilotHooksFile({ baseUrl: BASE, direct: true }));
		expect(parsed.version).toBe(1);
		for (const event of COPILOT_EVENT_ORDER) {
			const handler = parsed.hooks[event][0];
			expect(handler.type).toBe("command");
			expect(typeof handler.bash).toBe("string");
			expect(handler.timeoutSec).toBe(5);
			expect(handler.powershell).toBeUndefined();
		}
	});

	test("each entry's bash command contains ?event=<its own key> and X-Agent-Type: copilot_cli", () => {
		const parsed = JSON.parse(buildCopilotHooksFile({ baseUrl: BASE, direct: false }));
		for (const event of COPILOT_EVENT_ORDER) {
			const bash = parsed.hooks[event][0].bash as string;
			expect(bash).toContain(`?event=${event}`);
			expect(bash).toContain("X-Agent-Type: copilot_cli");
		}
	});

	test("includePowerShell adds a powershell string alongside bash", () => {
		const parsed = JSON.parse(
			buildCopilotHooksFile({ baseUrl: BASE, direct: true, includePowerShell: true }),
		);
		for (const event of COPILOT_EVENT_ORDER) {
			const handler = parsed.hooks[event][0];
			expect(typeof handler.bash).toBe("string");
			expect(typeof handler.powershell).toBe("string");
		}
	});

	test("byte-stable across repeated calls", () => {
		const opts = { baseUrl: BASE, direct: true };
		expect(buildCopilotHooksFile(opts)).toBe(buildCopilotHooksFile(opts));
	});

	test("keys are emitted in COPILOT_EVENT_ORDER", () => {
		const parsed = JSON.parse(buildCopilotHooksFile({ baseUrl: BASE, direct: false }));
		expect(Object.keys(parsed.hooks)).toEqual([...COPILOT_EVENT_ORDER]);
	});
});

describe("buildBashExcludeSnippet — no-stdout shape and posix sh compatibility", () => {
	// The snippet is inert in this phase (not yet spliced into the detached
	// subshell a real hook command runs in), so only checkNoStdoutShape's
	// TOKEN rules apply here — its detached-tail structural check is
	// specific to buildBashHookCommand's own output shape, which this
	// snippet, on its own, never has. Same five patterns, checked directly.
	test("has no echo/printf/tee/jq/bare-cat (checkNoStdoutShape's token rules)", () => {
		const snippet = buildBashExcludeSnippet();
		expect(snippet).not.toMatch(/\becho\b/);
		expect(snippet).not.toMatch(/\bprintf\b/);
		expect(snippet).not.toMatch(/\btee\b/);
		expect(snippet).not.toMatch(/\bjq\b/);
		const bareCat = snippet.match(/\bcat\b(?!\s*>)/g);
		expect(bareCat).toBeNull();
	});

	test("has no [[, $'...', function/source keywords, array assignment, or == comparison", () => {
		const snippet = buildBashExcludeSnippet();
		expect(snippet).not.toMatch(/\[\[\s/);
		expect(snippet).not.toContain("$'");
		expect(snippet).not.toMatch(/\bfunction\s/);
		expect(snippet).not.toMatch(/\bsource\s/);
		expect(snippet).not.toMatch(/\w+=\(/);
		expect(snippet).not.toMatch(/[^=!<>]==[^=]/);
	});

	test("byte-stable across repeated calls", () => {
		expect(buildBashExcludeSnippet()).toBe(buildBashExcludeSnippet());
	});

	test("builds the rules and marker paths from the shared .agentpulse constants", () => {
		const snippet = buildBashExcludeSnippet();
		expect(snippet).toContain('"$HOME/.agentpulse"');
		expect(snippet).toContain('"$ap_dir/exclude"');
		expect(snippet).toContain('"$ap_dir/exclude.invalid"');
	});
});

describe("buildPowerShellExcludeSnippet (never executed)", () => {
	test("byte-stable across repeated calls", () => {
		expect(buildPowerShellExcludeSnippet()).toBe(buildPowerShellExcludeSnippet());
	});

	test("builds the rules and marker paths from the shared .agentpulse constants", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).toContain("Join-Path $HOME '.agentpulse'");
		expect(snippet).toContain("Join-Path $apDir 'exclude'");
		expect(snippet).toContain("Join-Path $apDir 'exclude.invalid'");
	});

	// The PowerShell write-rights check only matched
	// FileSystemRights by name, but .NET's Flags-enum ToString() falls back
	// to a raw integer whenever the value doesn't correspond to a known
	// named combination — exactly the gap exclude-rules.ts's own
	// hasWriteCapableRight already closes with a numeric-mask fallback.
	// These extract both the name list and the mask straight out of the
	// generated PowerShell text and compare them to the TypeScript
	// constants, so the two can never silently drift apart again.
	function extractPowerShellWriteNames(snippet: string): string[] {
		const m = /\$apWriteNames = @\(([^)]*)\)/.exec(snippet);
		if (!m) throw new Error("could not find $apWriteNames in generated PowerShell");
		return m[1]
			.split(",")
			.map((s: string) => s.trim().replace(/^'|'$/g, ""))
			.filter((s: string) => s.length > 0);
	}

	function extractPowerShellWriteRightsMask(snippet: string): number {
		const m = /\$apWriteRightsMask = (0x[0-9A-Fa-f]+(?:\s+-bor\s+0x[0-9A-Fa-f]+)*)/.exec(snippet);
		if (!m) throw new Error("could not find $apWriteRightsMask in generated PowerShell");
		return m[1]
			.split("-bor")
			.map((s) => Number(s.trim()))
			.reduce((acc, n) => acc | n, 0);
	}

	test("the write-rights name list matches exclude-rules.ts's WRITE_CAPABLE_RIGHT_NAMES exactly", () => {
		const names = extractPowerShellWriteNames(buildPowerShellExcludeSnippet());
		expect(new Set(names)).toEqual(WRITE_CAPABLE_RIGHT_NAMES);
	});

	test("the write-rights numeric mask matches exclude-rules.ts's WRITE_CAPABLE_RIGHTS_MASK exactly", () => {
		const mask = extractPowerShellWriteRightsMask(buildPowerShellExcludeSnippet());
		expect(mask).toBe(WRITE_CAPABLE_RIGHTS_MASK);
	});

	test("falls back to the numeric mask when FileSystemRights renders as a bare integer, same as the TypeScript evaluator", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).toMatch(/-band\s+\$apWriteRightsMask/);
		expect(snippet).toMatch(/-match\s+'\^-\?\\d\+\$'/);
	});

	// An adjacent correctness bug found while wiring the numeric
	// fallback above: a root rule already resolves with a trailing
	// separator ("C:\"), so appending another one before the StartsWith
	// check made a root rule never match anything but itself.
	test("a root rule's resolved form is not double-separated before the StartsWith check", () => {
		const snippet = buildPowerShellExcludeSnippet();
		// The buggy form appended a literal backslash unconditionally before
		// the StartsWith check — for a root rule, whose resolved form
		// already ends in "\", that produced "C:\\" (two backslashes),
		// which a real descendant path like "C:\Users\alice" (one
		// backslash) never starts with, so a root rule could only ever
		// match itself exactly.
		expect(snippet).not.toContain('StartsWith("$apResolvedCmp\\")');
	});
});

describe("buildBashExcludeSnippet — source hygiene and encoding survival", () => {
	const source = readFileSync(join(import.meta.dir, "hook-command.ts"), "utf-8");
	const start = source.indexOf("export function buildBashExcludeSnippet");
	const end = source.indexOf("export function buildPowerShellExcludeSnippet");
	const templateSource = source.slice(start, end);

	test("the generator's template source holds no literal tab, carriage return or U+FEFF (escapes only)", () => {
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		// The function body's own indentation is a tab; look at everything
		// after each line's leading indentation.
		const bodies = templateSource.split("\n").map((line) => line.replace(/^\t+/, ""));
		for (const [i, body] of bodies.entries()) {
			expect(
				/[\t\r\uFEFF]/.test(body),
				`line ${i + 1} of the generator: ${JSON.stringify(body)}`,
			).toBe(false);
		}
	});

	test("the generated text still carries the real tab, CR, newline and BOM the trim set and BOM strip need", () => {
		const snippet = buildBashExcludeSnippet();
		expect(snippet).toContain('ap_trimset=" \t');
		expect(snippet).toContain("\r");
		expect(snippet).toContain("\uFEFF");
	});

	for (const platform of [undefined, "darwin", "linux"] as const) {
		test(`survives a JSON round trip byte for byte [${platform ?? "probe"}]`, () => {
			const snippet = buildBashExcludeSnippet(platform ? { platform } : undefined);
			expect(JSON.parse(JSON.stringify({ command: snippet })).command).toBe(snippet);
			expect(JSON.parse(JSON.stringify({ command: snippet }, null, 2)).command).toBe(snippet);
		});

		test(`survives a TOML basic-string round trip byte for byte [${platform ?? "probe"}]`, () => {
			const snippet = buildBashExcludeSnippet(platform ? { platform } : undefined);
			const escaped = snippet
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\n/g, "\\n")
				.replace(/\r/g, "\\r")
				// Bun's TOML parser decodes the short escape \t as a form feed;
				// the \u0009 form is read correctly, so it is the one used here.
				.replace(/\t/g, "\\u0009");
			const parsed = Bun.TOML.parse(`command = "${escaped}"`) as { command: string };
			expect(parsed.command).toBe(snippet);
		});
	}
});

describe("buildBashExcludeSnippet — platform probe option", () => {
	test("the default is the real probe, with the case branch decided at run time", () => {
		expect(buildBashExcludeSnippet()).toContain("/System/Library/CoreServices");
	});

	test("an explicit platform replaces the probe: darwin and linux are fixed", () => {
		const darwin = buildBashExcludeSnippet({ platform: "darwin" });
		const linux = buildBashExcludeSnippet({ platform: "linux" });
		expect(darwin).not.toContain("/System/Library/CoreServices");
		expect(linux).not.toContain("/System/Library/CoreServices");
		expect(darwin).toContain("ap_is_darwin=1");
		expect(linux).toContain("ap_is_darwin=0");
		expect(darwin).not.toBe(linux);
	});
});

describe("buildPowerShellExcludeSnippet — read, fail-closed and resolution rules (by reading; never executed)", () => {
	const snippet = buildPowerShellExcludeSnippet();

	test("the rules file is read as UTF-8 explicitly, split on LF only, never through Get-Content", () => {
		expect(snippet).not.toContain("Get-Content");
		expect(snippet).toContain("[System.IO.File]::ReadAllText($apRules");
		expect(snippet).toContain("UTF8Encoding");
		expect(snippet).toMatch(/-split "`n"/);
	});

	test("a read error fails closed (invalid), it never becomes an empty rule list", () => {
		expect(snippet).toMatch(/catch \{\s*\$apValid = \$false/);
		expect(snippet).not.toContain("$apLines = @()");
	});

	test("existence of the rules file distinguishes not-found from every other error", () => {
		expect(snippet).toContain("ItemNotFoundException");
		expect(snippet).toContain("$apLookupError");
		// Test-Path answers false for "access denied" too, so it can't decide existence.
		expect(snippet).not.toMatch(/Test-Path -LiteralPath \$apRules -ErrorAction/);
	});

	test("the marker is created without truncation, only when the directory passed and the marker is not a link", () => {
		expect(snippet).not.toMatch(/New-Item -ItemType File -Force -Path \$apMarker/);
		expect(snippet).toContain("[System.IO.FileMode]::OpenOrCreate");
		expect(snippet).toMatch(/if \(\$apDirOk -and -not \(ApIsReparsePoint \$apMarker\)\)/);
	});

	test("the skip value is trimmed with the explicit space, tab, CR, LF set", () => {
		expect(snippet).toContain('$apSkipTrimmed.Trim(\' \', "`t", "`r", "`n")');
		expect(snippet).not.toMatch(/\$apSkipTrimmed\.Trim\(\)/);
	});

	test("cwd and rules both resolve through symlinks and junctions with the same walker", () => {
		expect(snippet).toContain("function ApResolveLinks");
		expect(snippet).toContain(".LinkType");
		expect(snippet).toContain(".Target");
		expect(snippet).toMatch(/\$apCwd = ApResolveLinks/);
		expect(snippet).toMatch(/\$apResolved = ApResolve \$apExpanded/);
	});

	test("an unset or empty HOME fails closed", () => {
		expect(snippet).toMatch(/IsNullOrEmpty\(\$HOME\)/);
	});

	test("the whole file is validated: a match never breaks out of the loop early", () => {
		expect(snippet).not.toMatch(/\$apMatch = \$true\s*\n\s*break/);
	});

	test("a rule that resolves to something no drive path can match is invalid, not inert", () => {
		expect(snippet).toMatch(/\$apResolved -notmatch '\^\[A-Za-z\]:/);
	});

	test("an unknown working directory with rules present is excluded", () => {
		expect(snippet).toMatch(/IsNullOrEmpty\(\$apCwd\)/);
	});
});

describe("buildBashHookCommand — the gate in front of the send; the check itself is not inlined", () => {
	const CELLS = [
		{ agent: "codex_cli", direct: false },
		{ agent: "codex_cli", direct: true },
		{ agent: "copilot_cli", direct: false },
		{ agent: "copilot_cli", direct: true },
	] as const;
	/** A command stays small enough to read in an approval screen and to fit cmd.exe's 8,191 characters ten times over. */
	const COMMAND_SIZE_LIMIT = 2000;

	for (const cell of CELLS) {
		const label = `${cell.agent} ${cell.direct ? "direct" : "relay"}`;
		const build = () =>
			buildBashHookCommand({
				baseUrl: BASE,
				direct: cell.direct,
				agent: cell.agent,
				event: "Stop",
			});

		test(`${label}: the command stays small (<= ${COMMAND_SIZE_LIMIT} bytes) and carries no copy of the check`, () => {
			const cmd = build();
			expect(cmd.length).toBeLessThanOrEqual(COMMAND_SIZE_LIMIT);
			expect(cmd).not.toContain("ap_rules");
			expect(cmd).not.toContain("ap_dir=");
			expect(cmd).not.toContain("ap_lower");
		});

		test(`${label}: traps, then the marker (Codex), then the gate, then the send, in that order`, () => {
			const cmd = build();
			const subshell = cmd.indexOf("( trap 'rm -f \"$t\"' EXIT; trap 'exit 1' HUP INT TERM; ");
			const gate = cmd.indexOf("case $x in 1|[Tt][Rr][Uu][Ee]");
			const script = cmd.indexOf('/bin/sh "$d/exclude-check.sh"');
			const curl = cmd.indexOf("curl -sS");
			expect(subshell).toBeGreaterThan(-1);
			expect(gate).toBeGreaterThan(subshell);
			expect(script).toBeGreaterThan(gate);
			expect(curl).toBeGreaterThan(script);
			if (cell.agent === "codex_cli") {
				const marker = cmd.indexOf("codex-native");
				expect(marker).toBeGreaterThan(subshell);
				expect(marker).toBeLessThan(gate);
			}
			expect(cmd.split("exclude-check.sh").length - 1).toBe(2); // listed once, run once
			expect(cmd.split("/bin/sh").length - 1, "one explicit interpreter").toBe(1);
		});

		test(`${label}: the payload is removed by the EXIT trap, not by a trailing rm that a kill would skip`, () => {
			const cmd = build();
			expect(cmd).toContain(`trap 'rm -f "$t"' EXIT`);
			expect(cmd).toContain("trap 'exit 1' HUP INT TERM");
			expect(cmd).not.toMatch(/; rm -f "\$t" \) <\/dev\/null/);
		});

		test(`${label}: still ends with the detached tail and passes the no-stdout shape`, () => {
			const cmd = build();
			expect(cmd.endsWith(") </dev/null >/dev/null 2>&1 & exit 0")).toBe(true);
			expect(cmd).not.toMatch(/\becho\b|\btee\b|\bjq\b/);
			expect(cmd.match(/\bcat\b(?!\s*>)/g)).toBeNull();
		});

		test(`${label}: no word splitting, no heredoc, no multi-variable read: only constructs every shell agrees on`, () => {
			const cmd = build();
			expect(cmd).not.toContain("<<");
			expect(cmd).not.toMatch(/\bread\b/);
			expect(cmd).not.toMatch(/\bset -- /);
			expect(cmd).not.toMatch(/\bIFS\b/);
			expect(cmd).not.toContain("\n");
			expect(cmd).not.toContain("\t");
			expect(cmd).not.toContain("\r");
		});
	}

	test("the gate names the installed script by the shared constant's file name", () => {
		expect(EXCLUDE_SCRIPT_RELATIVE_PATH).toBe(".agentpulse/exclude-check.sh");
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "Stop",
		});
		expect(cmd).toContain(`$d/${EXCLUDE_SCRIPT_RELATIVE_PATH.split("/")[1]}`);
	});

	test("the web bundle's import graph does not reach the Node-only evaluator", () => {
		const source = readFileSync(join(import.meta.dir, "hook-command.ts"), "utf-8");
		const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gms)].map((m) => m[1]);
		expect(imports).toEqual(["./hook-headers.js"]);
	});
});

describe("the installed checks say what their trust check covers", () => {
	test("both name the limit: the directory and the script are checked, its ancestors are not", () => {
		for (const script of [buildBashExcludeScript(), buildPowerShellExcludeScript()]) {
			const header = script.split("\n").filter((l) => l.startsWith("#"));
			const note = header.join(" ");
			expect(note).toContain("ancestors");
			expect(note).toContain("symlink");
			expect(note).toContain("not protected");
		}
	});

	test("the note sits after the hash line, so line 2 of the shell script is still the hash", () => {
		const script = buildBashExcludeScript();
		expect(script.split("\n")[1]).toMatch(/^# agentpulse-exclude-check [0-9a-f]{14}$/);
		expect(excludeScriptHeaderHash(script)).toMatch(/^[0-9a-f]{14}$/);
	});
});

describe("buildBashExcludeScript — the installed check", () => {
	test("opens with the interpreter line and a content hash, then the snippet, then an exit status", () => {
		const script = buildBashExcludeScript();
		expect(script.startsWith("#!/bin/sh\n# agentpulse-exclude-check ")).toBe(true);
		expect(script).toContain(buildBashExcludeSnippet());
		expect(script.endsWith('if [ "$ap_excluded" = "1" ]; then exit 1; fi\nexit 42\n')).toBe(true);
		expect(excludeScriptHeaderHash(script)).toMatch(/^[0-9a-f]{14}$/);
	});

	test("the hash changes with the content and is stable for the same content", () => {
		expect(buildBashExcludeScript()).toBe(buildBashExcludeScript());
		const darwin = excludeScriptHeaderHash(buildBashExcludeScript({ platform: "darwin" }));
		const linux = excludeScriptHeaderHash(buildBashExcludeScript({ platform: "linux" }));
		expect(darwin).not.toBeNull();
		expect(darwin).not.toBe(linux);
	});

	test("a file that isn't one is not given a hash", () => {
		expect(excludeScriptHeaderHash("#!/bin/sh\nexit 0\n")).toBeNull();
		expect(excludeScriptHeaderHash("")).toBeNull();
	});

	test("prints nothing: no echo/printf/tee/jq anywhere in it", () => {
		expect(buildBashExcludeScript()).not.toMatch(/\becho\b|\bprintf\b|\btee\b|\bjq\b/);
	});

	test("the installer form is ASCII only and round-trips to the real script", () => {
		const forInstaller = buildBashExcludeScriptForInstaller();
		expect([...forInstaller].every((c) => c === "\n" || (c >= " " && c <= "~"))).toBe(true);
		const restored = forInstaller
			.split(INSTALLER_SNIPPET_PLACEHOLDERS.tab)
			.join("\t")
			.split(INSTALLER_SNIPPET_PLACEHOLDERS.cr)
			.join("\r")
			.split(INSTALLER_SNIPPET_PLACEHOLDERS.bom)
			.join("\uFEFF");
		expect(restored).toBe(buildBashExcludeScript());
	});
});

describe("buildPowerShellHookCommand — the gate in front of the send; the check itself is not inlined (never executed)", () => {
	const build = (agent: string, direct = true) =>
		buildPowerShellHookCommand({ baseUrl: BASE, direct, agent, event: "Stop" });
	/** Well under cmd.exe's 8,191 characters even if the string passes through it once. */
	const PS_COMMAND_SIZE_LIMIT = 6000;

	test("the command stays small and carries no copy of the check", () => {
		for (const agent of ["codex_cli", "copilot_cli"]) {
			for (const direct of [false, true]) {
				const cmd = build(agent, direct);
				expect(cmd.length, `${agent} direct=${direct}`).toBeLessThanOrEqual(PS_COMMAND_SIZE_LIMIT);
				expect(cmd).not.toContain("$apRules");
				expect(cmd).not.toContain("ApResolveLinks");
				expect(cmd).not.toContain("$apMatch");
			}
		}
	});

	test("the parent passes its current location and the skip variable through -ArgumentList", () => {
		const cmd = build("codex_cli");
		expect(cmd).toMatch(
			/-ArgumentList \$t, \$f, 'http:\/\/localhost:4000\/api\/v1\/hooks\?event=Stop', 'codex_cli', \(Get-Location\)\.Path, \$env:AGENTPULSE_SKIP \| Out-Null/,
		);
		expect(cmd).toContain("param($t, $f, $url, $agent, $apJobCwd, $apJobSkip)");
	});

	test("inside the job the gate reads those parameters, never the location or the environment", () => {
		const cmd = build("codex_cli");
		const job = cmd.slice(cmd.indexOf("Start-Job"), cmd.indexOf("} -ArgumentList"));
		expect(job).not.toContain("(Get-Location)");
		expect(job).not.toContain("$env:AGENTPULSE_SKIP");
		expect(job).toContain("$apJobCwd");
		expect(job).toContain("$apJobSkip");
	});

	test("before Start-Job the parent does no file or process work beyond the stdin drain and temp write", () => {
		const cmd = build("codex_cli");
		const before = cmd.slice(0, cmd.indexOf("Start-Job"));
		expect(before).not.toContain("Get-Location");
		expect(before).not.toContain("ApCheckSecurity");
		expect(before).not.toContain("exclude");
	});

	test("order in the job: marker (Codex), then the gate, then the guarded send; the payload is removed in a finally", () => {
		const cmd = build("codex_cli");
		const marker = cmd.indexOf("codex-native");
		const gate = cmd.indexOf("$apGo = $true");
		const curl = cmd.indexOf("Start-Process -FilePath curl.exe");
		expect(marker).toBeGreaterThan(-1);
		expect(gate).toBeGreaterThan(marker);
		expect(curl).toBeGreaterThan(gate);
		expect(cmd).toMatch(/if \(\$apGo\) \{\n {4}\$headerArgs/);
		expect(cmd).toMatch(
			/\} finally \{\n {4}Remove-Item -Force \$t -ErrorAction SilentlyContinue\n {2}\}\n\} -ArgumentList/,
		);
		expect(cmd.indexOf("try {")).toBeLessThan(marker);
	});

	test("header arguments are built by an assigning if statement: an inline $(if ...) yields $null when false, and a null element makes Start-Process refuse the argument list (never executed)", () => {
		for (const direct of [false, true]) {
			const cmd = buildPowerShellHookCommand({
				baseUrl: "http://localhost:4000",
				direct,
				agent: "copilot_cli",
				event: "Stop",
			});
			expect(cmd).not.toContain("$(if");
			expect(cmd).toContain("$headerArgs = @()\n");
			expect(cmd).toMatch(/\n {4}if \(\$f -and .*\) \{ \$headerArgs = @\('-H', "@\$f"\) \}\n/);
			// the array is built before the send, and never appended to with a bare expression
			expect(cmd.indexOf("$headerArgs = @()")).toBeLessThan(cmd.indexOf("$curlArgs"));
		}
	});

	test("the skip variable is trimmed with the explicit set and matched against the same allowlist as every evaluator", () => {
		const cmd = build("copilot_cli");
		expect(cmd).toContain(`$apSkip.Trim(' ', "\`t", "\`r", "\`n").ToLowerInvariant()`);
		expect(cmd).toContain("@('1','true','yes','on') -contains");
	});

	test("an empty HOME sends nothing; a rules file or any lookup error but not-found hands the decision to the script", () => {
		const cmd = build("copilot_cli");
		expect(cmd).toContain("[string]::IsNullOrEmpty($HOME)) { $apGo = $false }");
		expect(cmd).toContain("catch [System.Management.Automation.ItemNotFoundException] { }");
		expect(cmd).toContain("catch [System.Management.Automation.DriveNotFoundException] { }");
		expect(cmd).toMatch(/\n\s*catch \{ \$apHand = \$true \}/);
		// a link that points nowhere is invalid, not "no rules"
		expect(cmd).toContain("-not (Test-Path -LiteralPath $apDir)) { $apHand = $true }");
	});

	test("the script runs only after the directory and the file pass the same ACL check as the evaluator, as a plain file, never through a link", () => {
		const cmd = build("copilot_cli");
		expect(cmd).toContain("exclude-check.ps1");
		expect(cmd).toContain("(ApCheckSecurity $apDir)");
		expect(cmd).toContain("(ApCheckSecurity $apScript)");
		expect(cmd).toContain("-PathType Leaf");
		expect(cmd).toContain("-not (ApIsReparsePoint $apScript)");
		// fail closed until proven otherwise
		expect(cmd).toMatch(/\$apGo = \$false\n\s*function ApCheckSecurity/);
	});

	test("the script is run by the same PowerShell host, with execution policy bypassed for that one file, from the agent's directory, and its exit code decides", () => {
		const cmd = build("copilot_cli");
		expect(cmd).toContain("(Get-Process -Id $PID).Path");
		expect(cmd).toContain("'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'");
		expect(cmd).toContain("-WorkingDirectory $apJobCwd");
		expect(cmd).toContain("-Wait -PassThru");
		expect(cmd).toContain("$apProc.ExitCode -eq 42) { $apGo = $true }");
	});

	test("the ACL check inside the command is the evaluator's, name list and mask included", () => {
		const cmd = build("copilot_cli");
		const names = /\$apWriteNames = @\(([^)]*)\)/.exec(cmd);
		expect(names).not.toBeNull();
		const parsed = (names?.[1] ?? "")
			.split(",")
			.map((n) => n.trim().replace(/^'|'$/g, ""))
			.filter((n) => n.length > 0);
		expect(new Set(parsed)).toEqual(WRITE_CAPABLE_RIGHT_NAMES);
		const mask = /\$apWriteRightsMask = (0x[0-9A-Fa-f]+(?:\s+-bor\s+0x[0-9A-Fa-f]+)*)/.exec(cmd);
		expect(
			(mask?.[1] ?? "")
				.split("-bor")
				.map((n) => Number(n.trim()))
				.reduce((a, n) => a | n, 0),
		).toBe(WRITE_CAPABLE_RIGHTS_MASK);
	});

	test("the Codex marker is created exclusively and never through a link", () => {
		const cmd = build("codex_cli");
		expect(cmd).toContain("function ApIsReparsePoint");
		expect(cmd).toContain("if (-not (ApIsReparsePoint $md))");
		expect(cmd).toContain("if (-not (ApIsReparsePoint $mf))");
		expect(cmd).toContain("[IO.FileMode]::CreateNew");
		expect(cmd).not.toContain("New-Item -ItemType File");
	});

	test("copilot has the gate too, with no marker", () => {
		const cmd = build("copilot_cli");
		expect(cmd).toContain("$apGo = $true");
		expect(cmd).not.toContain("codex-native");
	});
});

describe("buildPowerShellExcludeScript — the installed PowerShell check (never executed)", () => {
	test("opens with a content-hash comment, then the snippet read from the live location and environment, then an exit status", () => {
		const script = buildPowerShellExcludeScript();
		expect(script.startsWith("# agentpulse-exclude-check ")).toBe(true);
		expect(excludeScriptHeaderHash(script)).toMatch(/^[0-9a-f]{14}$/);
		expect(script).toContain(buildPowerShellExcludeSnippet());
		expect(script).toContain("(Get-Location).Path");
		expect(script).toContain("$env:AGENTPULSE_SKIP");
		expect(script.endsWith("if ($apExcluded) { exit 1 }\nexit 42\n")).toBe(true);
	});

	test("is byte-stable and its hash tracks the content", () => {
		expect(buildPowerShellExcludeScript()).toBe(buildPowerShellExcludeScript());
		expect(excludeScriptHeaderHash(buildPowerShellExcludeScript())).not.toBe(
			excludeScriptHeaderHash(buildBashExcludeScript()),
		);
	});

	test("the snippet no longer has an in-job variant", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).not.toContain("$apJobCwd");
		expect(snippet).not.toContain("$apJobSkip");
	});

	test("a rule list longer than the cap is invalid, like the other evaluators", () => {
		expect(buildPowerShellExcludeSnippet()).toContain(`$apNRules -gt ${EXCLUDE_MAX_RULES}`);
	});

	test("a link at ~/.agentpulse that points nowhere is invalid, not 'no rules' (never executed)", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).toContain("$apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)");
		expect(snippet).toMatch(/\$apPresent = \$true\n\s+\$apLookupError = \$true/);
	});

	test("the ACL check exempts exactly the user, SYSTEM and Administrators, so a directory with those three inherited ACEs is valid (never executed)", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).toContain("$apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')");
		expect(snippet).toContain("if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }");
		// the owner is held to the same set, so an Administrators-owned directory passes too
		expect(snippet).toContain("-not ($apExempt -contains $apOwnerSid)");
		// a Deny ACE is never itself a reason to fail
		expect(snippet).toContain("-ne 'Allow') { continue }");
	});

	test("a stale marker is cleared when the rules file is gone and the directory is trusted", () => {
		const snippet = buildPowerShellExcludeSnippet();
		expect(snippet).toMatch(/if \(-not \$apPresent -and -not \$apExcluded\) \{/);
	});
});
