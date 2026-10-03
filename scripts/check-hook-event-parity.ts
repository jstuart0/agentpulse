#!/usr/bin/env bun
/**
 * Architecture guard: hook-event-list parity (client-currency campaign,
 * Phase 3 deliverable — plan's "Pattern parity / wiring sites" drift guard).
 *
 * The Claude Code and Codex CLI hook-event lists are duplicated across
 * six code sites (five script/CLI sites + the in-app SetupPage.tsx "Copy
 * Config" copy) that must stay in lockstep with the src/shared/types.ts
 * ClaudeCodeEvent / CodexEvent unions. This guard extracts the event-name
 * list at each site and fails on any drift — same shape as
 * check-no-authentik-literals.ts (collect hits, exit non-zero with a report).
 *
 * Extraction is regex-based, not an AST parse — a grep-count floor per the
 * plan's own fallback clause. Every site embeds its event list as either a
 * flat run of quoted PascalCase tokens (bash arrays, PowerShell @(...)
 * arrays, TS array literals) or, for install-local.ps1's Codex hash-array,
 * a run of `event = "X"` key/value entries. Both shapes are covered below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	SH_TRIM_SET_PRINTF,
	buildBashHookCommand,
	buildCodexHooksFile,
	buildCopilotHooksFile,
} from "../src/shared/hook-command.js";
import {
	describe,
	extractQuotedListBlocks,
	extractQuotedListBlocksCamelCase,
	extractUnion,
	sameSet,
} from "./lib/parity-utils.js";

const ROOT = new URL("..", import.meta.url).pathname;

function readFile(relPath: string): string {
	return readFileSync(join(ROOT, relPath), "utf8");
}

// 6 sites x 3 agents (Claude, Codex, Copilot).
const EXPECTED_RESULTS = 18;

/** Claude HTTP hook emitting constructs across the six sites (see CLAUDE_HTTP_HOOK_SITES). */
const EXPECTED_CLAUDE_HTTP_CONSTRUCTS = 9;

interface CheckResult {
	site: string;
	agent: "claude" | "codex" | "copilot";
	events: string[];
}

/**
 * Phase 5 (D12/D13): the no-stdout shape every Codex/Copilot command hook
 * must have. Exported so scripts/check-hook-event-parity.test.ts can prove
 * the rule actually discriminates (an `; echo ok`-tampered command fails
 * it), not just that the happy path passes.
 *
 * The command must:
 *  - end with the literal D13 detached tail
 *  - do its only non-curl stdin/stdout operation as `cat > "$t"`
 *  - contain no echo, printf, tee, jq, or a bare `cat` (one not followed by `>`);
 *    the one printf allowed is the exact trim-set substitution the skip check
 *    uses (a shell built-in that writes into a variable, never to stdout)
 */
export function checkNoStdoutShape(cmd: string, label: string): string[] {
	const violations: string[] = [];
	if (!cmd.endsWith(") </dev/null >/dev/null 2>&1 & exit 0")) {
		violations.push(`${label}: doesn't end with the D13 detached-tail skeleton`);
	}
	if (/\becho\b/.test(cmd)) violations.push(`${label}: contains echo`);
	if (/\bprintf\b/.test(cmd.split(SH_TRIM_SET_PRINTF).join("")))
		violations.push(`${label}: contains printf`);
	if (/\btee\b/.test(cmd)) violations.push(`${label}: contains tee`);
	if (/\bjq\b/.test(cmd)) violations.push(`${label}: contains jq`);
	if (/\bcat\b(?!\s*>)/.test(cmd))
		violations.push(`${label}: contains a bare cat (not followed by >)`);
	return violations;
}

/**
 * Phase 5: every Codex handler must be `type:"command"`, `async:false` —
 * never `"type":"http"` (the pre-0.145 shape that Codex 0.145 can't parse)
 * and never `async:true` (silently skipped on 0.145, SPIKE fact 4).
 *
 * Exercised dynamically against buildCodexHooksFile()'s real output rather
 * than a source-text scan: the four transcription sites (setup-hooks.sh,
 * setup-relay.sh, the /setup.sh template, install-local.ps1) don't embed a
 * literal hooks JSON any more — they call the shared generator — and their
 * byte-parity with it is separately proven by hook-command-parity.test.ts.
 */
function checkCodexHooksShape(mismatches: string[]) {
	const json = buildCodexHooksFile({ baseUrl: "http://localhost:4000", direct: false });
	if (json.includes('"type": "http"') || json.includes('"type":"http"')) {
		mismatches.push('buildCodexHooksFile(): output contains a "type":"http" handler');
	}
	if (json.includes('"async": true') || json.includes('"async":true')) {
		mismatches.push("buildCodexHooksFile(): output contains an async:true handler");
	}
	if (json.includes('"matcher"')) {
		mismatches.push(
			'buildCodexHooksFile(): output contains a "matcher" key (D12: omitted on every event)',
		);
	}

	// Phase 7: buildCopilotHooksFile's own shape — command handlers, no
	// preToolUse/permissionRequest keys, and the D7-registered event count.
	const copilotJson = buildCopilotHooksFile({ baseUrl: "http://localhost:4000", direct: false });
	if (!copilotJson.includes('"type": "command"')) {
		mismatches.push('buildCopilotHooksFile(): output is missing a "type":"command" handler');
	}
	if (copilotJson.includes('"preToolUse"')) {
		mismatches.push('buildCopilotHooksFile(): output contains "preToolUse" (D7: excluded)');
	}
	if (copilotJson.includes('"permissionRequest"')) {
		mismatches.push('buildCopilotHooksFile(): output contains "permissionRequest" (D7: excluded)');
	}
	const copilotEventCount = Object.keys(JSON.parse(copilotJson).hooks).length;
	if (copilotEventCount !== 10) {
		mismatches.push(`buildCopilotHooksFile(): expected 10 events, got ${copilotEventCount}`);
	}

	for (const agent of ["codex_cli", "copilot_cli"] as const) {
		for (const direct of [false, true]) {
			const cmd = buildBashHookCommand({
				baseUrl: "http://localhost:4000",
				direct,
				agent,
				event: "Stop",
			});
			mismatches.push(
				...checkNoStdoutShape(cmd, `buildBashHookCommand(agent=${agent},direct=${direct})`),
			);
		}
	}
}

/** The six files that emit Claude Code HTTP hook JSON, and how many emitting constructs each holds today (nine in all). */
const CLAUDE_HTTP_HOOK_SITES = [
	{ site: "scripts/setup-hooks.sh", kind: "sh-lines", constructs: 2 },
	{ site: "scripts/setup-relay.sh", kind: "sh-lines", constructs: 1 },
	{ site: "src/server/routes/setup.ts", kind: "sh-lines", constructs: 2 },
	{ site: "scripts/install-local.ps1", kind: "powershell", constructs: 1 },
	{ site: "bin/cli.ts", kind: "ts-objects", constructs: 2 },
	{ site: "src/web/pages/SetupPage.tsx", kind: "ts-objects", constructs: 1 },
] as const;

/** The text of the `{ ... }` object literal that encloses `index` (brace-balanced, ignoring braces inside strings). */
function enclosingObject(content: string, index: number): string {
	let start = index;
	for (let depth = 0; start > 0; start--) {
		const ch = content[start];
		if (ch === "}") depth++;
		if (ch === "{") {
			if (depth === 0) break;
			depth--;
		}
	}
	let end = start;
	for (let depth = 0; end < content.length; end++) {
		const ch = content[end];
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return content.slice(start, end + 1);
}

/** Every construct in `content` that emits one Claude HTTP hook entry. */
function claudeHttpHookConstructs(
	content: string,
	kind: (typeof CLAUDE_HTTP_HOOK_SITES)[number]["kind"],
): string[] {
	if (kind === "sh-lines") {
		return content.split("\n").filter((line) => /HOOKS_JSON\+=.*http/.test(line));
	}
	if (kind === "ts-objects") {
		return [...content.matchAll(/type:\s*"http"/g)].map((m) => enclosingObject(content, m.index));
	}
	// install-local.ps1 builds the headers table, the hook table and the
	// allowedEnvVars assignment in separate statements: take them as one.
	const start = content.indexOf("$hookHeadersClaude = @{");
	const end = content.indexOf("Set-JsonFile -Path $claudeSettings", start);
	return start === -1 || end === -1 ? [] : [content.slice(start, end)];
}

/**
 * Every Claude HTTP hook entry, at all six sites, must carry the skip
 * header (`X-AgentPulse-Skip: $AGENTPULSE_SKIP`) and list AGENTPULSE_SKIP in
 * `allowedEnvVars` — Claude Code expands header variables only for names
 * on that list. Exported so scripts/check-hook-event-parity.test.ts can
 * prove the rule discriminates.
 */
export function checkClaudeHttpHookSites(read: (relPath: string) => string): {
	problems: string[];
	constructCount: number;
} {
	const problems: string[] = [];
	let constructCount = 0;
	for (const { site, kind, constructs: expected } of CLAUDE_HTTP_HOOK_SITES) {
		const found = claudeHttpHookConstructs(read(site), kind);
		constructCount += found.length;
		if (found.length !== expected) {
			problems.push(
				`${site}: expected ${expected} Claude HTTP hook construct(s), found ${found.length} — extraction likely broken`,
			);
		}
		for (const [i, text] of found.entries()) {
			const label = `${site} [Claude HTTP hook #${i + 1}]`;
			if (!/X-AgentPulse-Skip[^A-Za-z0-9]{1,12}AGENTPULSE_SKIP/.test(text)) {
				problems.push(`${label}: missing the X-AgentPulse-Skip: $AGENTPULSE_SKIP header`);
			}
			if (kind === "powershell") {
				// The PowerShell installer builds the list in variables, one per form.
				const lists = [...text.matchAll(/\$allowedEnvVars = @\(([^)]*)\)/g)].map((m) => m[1] ?? "");
				if (lists.length === 0 || lists.some((list) => !list.includes("AGENTPULSE_SKIP"))) {
					problems.push(`${label}: every $allowedEnvVars list must include AGENTPULSE_SKIP`);
				}
			} else if (!/allowedEnvVars[^\]\)]*AGENTPULSE_SKIP/.test(text)) {
				problems.push(`${label}: allowedEnvVars does not list AGENTPULSE_SKIP`);
			}
		}
	}
	return { problems, constructCount };
}

function main() {
	const typesContent = readFile("src/shared/types.ts");
	const claudeCanonical = extractUnion(typesContent, "ClaudeCodeEvent");
	const codexCanonical = extractUnion(typesContent, "CodexEvent");
	const copilotCanonical = extractUnion(typesContent, "CopilotEvent");

	if (claudeCanonical.length === 0)
		throw new Error("ClaudeCodeEvent union extracted empty — check the marker");
	if (codexCanonical.length === 0)
		throw new Error("CodexEvent union extracted empty — check the marker");
	if (copilotCanonical.length === 0)
		throw new Error("CopilotEvent union extracted empty — check the marker");

	const results: CheckResult[] = [];

	// scripts/setup-hooks.sh, scripts/setup-relay.sh (also what
	// /setup-relay.sh serves, verbatim) and src/server/routes/setup.ts's one
	// embedded /setup.sh template. Phase 5 (D12/D13) gave all three sites the
	// same shared `# >>> agentpulse-hook-cmd` block, so all three now use
	// distinct `EVENTS=(` (Claude) / `CODEX_EVENTS=(` (Codex) names — exactly
	// one list per agent each; a second copy is exactly the drift this guards.
	for (const site of [
		"scripts/setup-hooks.sh",
		"scripts/setup-relay.sh",
		"src/server/routes/setup.ts",
	]) {
		const content = readFile(site);
		const claudeBlocks = extractQuotedListBlocks(content, /(?<![A-Z_])EVENTS=\(/, ")");
		const codexBlocks = extractQuotedListBlocks(content, /CODEX_EVENTS=\(/, ")");
		const copilotBlocks = extractQuotedListBlocksCamelCase(content, /COPILOT_EVENTS=\(/, ")");
		if (claudeBlocks.length !== 1 || codexBlocks.length !== 1 || copilotBlocks.length !== 1) {
			throw new Error(
				`${site}: expected exactly one EVENTS=(, one CODEX_EVENTS=( and one COPILOT_EVENTS=( list, found ${claudeBlocks.length}, ${codexBlocks.length} and ${copilotBlocks.length}`,
			);
		}
		results.push({ site, agent: "claude", events: claudeBlocks[0] });
		results.push({ site, agent: "codex", events: codexBlocks[0] });
		results.push({ site, agent: "copilot", events: copilotBlocks[0] });
	}

	// scripts/install-local.ps1 — Claude is a flat @(...) array; Codex and
	// Copilot are also flat @(...) arrays, consumed by New-ApCodexHooksFile/
	// New-ApCopilotHooksFile via the shared hook-command generators.
	{
		const content = readFile("scripts/install-local.ps1");
		const [claude] = extractQuotedListBlocks(content, /foreach \(\$eventName in @\(/, ")");
		const [codex] = extractQuotedListBlocks(content, /\$codexEvents = @\(/, ")");
		const [copilot] = extractQuotedListBlocksCamelCase(content, /\$copilotEvents = @\(/, ")");
		results.push({ site: "scripts/install-local.ps1", agent: "claude", events: claude ?? [] });
		results.push({ site: "scripts/install-local.ps1", agent: "codex", events: codex ?? [] });
		results.push({ site: "scripts/install-local.ps1", agent: "copilot", events: copilot ?? [] });
	}

	// bin/cli.ts — TS array literals.
	{
		const content = readFile("bin/cli.ts");
		const [claude] = extractQuotedListBlocks(content, /const claudeEvents = \[/, "]");
		const [codex] = extractQuotedListBlocks(content, /const codexEvents = \[/, "]");
		const [copilot] = extractQuotedListBlocksCamelCase(content, /const copilotEvents = \[/, "]");
		results.push({ site: "bin/cli.ts", agent: "claude", events: claude ?? [] });
		results.push({ site: "bin/cli.ts", agent: "codex", events: codex ?? [] });
		results.push({ site: "bin/cli.ts", agent: "copilot", events: copilot ?? [] });
	}

	// src/web/pages/SetupPage.tsx — Phase 5 (D12/D13) split the one
	// `hookEvents` ternary into per-agent lists: `claudeHookEvents` still
	// feeds the manual-copy generator directly, and `codexHookEvents`/
	// `copilotHookEvents` are guard-visible floors on buildCodexHooksFile()/
	// buildCopilotHooksFile()'s output (the JSON body itself comes from the
	// shared src/shared/hook-command.ts generator, not a literal array,
	// since Phase 5/7 need it byte-identical to the installers).
	{
		const content = readFile("src/web/pages/SetupPage.tsx");
		const [claude] = extractQuotedListBlocks(content, /const claudeHookEvents = \[/, "]");
		const [codex] = extractQuotedListBlocks(content, /const codexHookEvents = \[/, "]");
		const [copilot] = extractQuotedListBlocksCamelCase(
			content,
			/const copilotHookEvents = \[/,
			"]",
		);
		results.push({ site: "src/web/pages/SetupPage.tsx", agent: "claude", events: claude ?? [] });
		results.push({ site: "src/web/pages/SetupPage.tsx", agent: "codex", events: codex ?? [] });
		results.push({
			site: "src/web/pages/SetupPage.tsx",
			agent: "copilot",
			events: copilot ?? [],
		});
	}

	// 6 sites × 3 agents. A site whose extraction silently vanished would
	// otherwise shrink the population without failing.
	if (results.length !== EXPECTED_RESULTS) {
		throw new Error(`expected ${EXPECTED_RESULTS} site/agent lists, extracted ${results.length}`);
	}

	const CANONICAL_BY_AGENT = {
		claude: claudeCanonical,
		codex: codexCanonical,
		copilot: copilotCanonical,
	} as const;
	const UNION_NAME_BY_AGENT = {
		claude: "ClaudeCodeEvent",
		codex: "CodexEvent",
		copilot: "CopilotEvent",
	} as const;

	const mismatches: string[] = [];
	for (const result of results) {
		const canonical = CANONICAL_BY_AGENT[result.agent];
		if (result.events.length === 0) {
			mismatches.push(
				`${result.site} [${result.agent}]: extracted zero events — extraction likely broken`,
			);
			continue;
		}
		if (!sameSet(result.events, canonical)) {
			mismatches.push(
				`${result.site} [${result.agent}]: ${describe(result.events)} does not match types.ts ${UNION_NAME_BY_AGENT[result.agent]} ${describe(canonical)}`,
			);
		}
		// Phase 7 Verification: every Copilot list must contain postToolUse
		// and must not contain preToolUse or permissionRequest (D7's
		// deliberate exclusions — Copilot's fail-closed paths).
		if (result.agent === "copilot") {
			if (!result.events.includes("postToolUse")) {
				mismatches.push(`${result.site} [copilot]: missing postToolUse`);
			}
			if (result.events.includes("preToolUse")) {
				mismatches.push(`${result.site} [copilot]: must not contain preToolUse`);
			}
			if (result.events.includes("permissionRequest")) {
				mismatches.push(`${result.site} [copilot]: must not contain permissionRequest`);
			}
		}
	}

	checkCodexHooksShape(mismatches);

	const claudeHttp = checkClaudeHttpHookSites(readFile);
	mismatches.push(...claudeHttp.problems);
	if (claudeHttp.constructCount !== EXPECTED_CLAUDE_HTTP_CONSTRUCTS) {
		mismatches.push(
			`expected ${EXPECTED_CLAUDE_HTTP_CONSTRUCTS} Claude HTTP hook constructs across the six sites, found ${claudeHttp.constructCount}`,
		);
	}

	if (mismatches.length > 0) {
		console.error("Hook-event-list parity check failed:\n");
		console.error(mismatches.join("\n\n"));
		console.error(
			"\nAll six wiring sites (scripts/setup-hooks.sh, scripts/setup-relay.sh, " +
				"src/server/routes/setup.ts, scripts/install-local.ps1, bin/cli.ts, " +
				"src/web/pages/SetupPage.tsx) must register the exact same event set as the " +
				"src/shared/types.ts ClaudeCodeEvent / CodexEvent / CopilotEvent unions, and " +
				"every Claude HTTP hook they write must carry the skip header and list " +
				"AGENTPULSE_SKIP in allowedEnvVars.",
		);
		process.exit(1);
	}

	console.log(
		`OK: hook-event lists match across all ${results.length / 3} wiring sites (Claude: ${describe(claudeCanonical)}, Codex: ${describe(codexCanonical)}, Copilot: ${describe(copilotCanonical)})`,
	);
}

if (import.meta.main) main();
