#!/usr/bin/env bun
/**
 * Architecture guard: hook-event-list parity (client-currency campaign,
 * Phase 3 deliverable — plan's "Pattern parity / wiring sites" drift guard).
 *
 * The Claude Code and Codex CLI hook-event lists are duplicated across
 * seven code sites (six script/CLI sites + the in-app SetupPage.tsx "Copy
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

const ROOT = new URL("..", import.meta.url).pathname;

function readFile(relPath: string): string {
	return readFileSync(join(ROOT, relPath), "utf8");
}

/**
 * Find every non-overlapping occurrence of `marker` in `content`, and for
 * each, extract quoted PascalCase tokens between the marker and the next
 * `terminator` character. Returns one array of event names per occurrence.
 */
function extractQuotedListBlocks(content: string, marker: RegExp, terminator: string): string[][] {
	const blocks: string[][] = [];
	const globalMarker = new RegExp(
		marker.source,
		marker.flags.includes("g") ? marker.flags : `${marker.flags}g`,
	);
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop idiom
	while ((match = globalMarker.exec(content)) !== null) {
		const start = match.index + match[0].length;
		const end = content.indexOf(terminator, start);
		if (end === -1) continue;
		const slice = content.slice(start, end);
		const tokens = [...slice.matchAll(/"([A-Z][A-Za-z]+)"/g)].map((m) => m[1]);
		blocks.push(tokens);
		globalMarker.lastIndex = end;
	}
	return blocks;
}

/** Extract `event = "X"` key/value tokens between marker and terminator (install-local.ps1's Codex hash-array shape). */
function extractKeyValueListBlock(content: string, marker: RegExp, terminator: string): string[] {
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`marker not found: ${marker}`);
	const end = content.indexOf(terminator, idx);
	if (end === -1) throw new Error(`terminator not found after marker: ${marker}`);
	const slice = content.slice(idx, end);
	return [...slice.matchAll(/event\s*=\s*"([A-Z][A-Za-z]+)"/g)].map((m) => m[1]);
}

function extractUnion(content: string, typeName: string): string[] {
	const marker = new RegExp(`export type ${typeName} =`);
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`type not found in types.ts: ${typeName}`);
	const end = content.indexOf(";", idx);
	if (end === -1) throw new Error(`unterminated type: ${typeName}`);
	const slice = content.slice(idx, end);
	return [...slice.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
}

function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((v, i) => v === sortedB[i]);
}

function describe(events: string[]): string {
	return `[${[...events].sort().join(", ")}]`;
}

interface CheckResult {
	site: string;
	agent: "claude" | "codex";
	events: string[];
}

function main() {
	const typesContent = readFile("src/shared/types.ts");
	const claudeCanonical = extractUnion(typesContent, "ClaudeCodeEvent");
	const codexCanonical = extractUnion(typesContent, "CodexEvent");

	if (claudeCanonical.length === 0)
		throw new Error("ClaudeCodeEvent union extracted empty — check the marker");
	if (codexCanonical.length === 0)
		throw new Error("CodexEvent union extracted empty — check the marker");

	const results: CheckResult[] = [];

	// scripts/setup-hooks.sh — both the Claude and Codex branches reuse the
	// same `EVENTS=(...)` variable name (Claude branch first, Codex second),
	// unlike every other site which distinguishes CODEX_EVENTS.
	{
		const content = readFile("scripts/setup-hooks.sh");
		const [claude, codex] = extractQuotedListBlocks(content, /(?<![A-Z_])EVENTS=\(/, ")");
		results.push({ site: "scripts/setup-hooks.sh", agent: "claude", events: claude ?? [] });
		results.push({ site: "scripts/setup-hooks.sh", agent: "codex", events: codex ?? [] });
	}

	// scripts/setup-relay.sh — same shape.
	{
		const content = readFile("scripts/setup-relay.sh");
		const [claude] = extractQuotedListBlocks(content, /(?<![A-Z_])EVENTS=\(/, ")");
		const [codex] = extractQuotedListBlocks(content, /CODEX_EVENTS=\(/, ")");
		results.push({ site: "scripts/setup-relay.sh", agent: "claude", events: claude ?? [] });
		results.push({ site: "scripts/setup-relay.sh", agent: "codex", events: codex ?? [] });
	}

	// src/server/routes/setup.ts — two embedded bash templates, each with
	// its own EVENTS=(...) / CODEX_EVENTS=(...) pair.
	{
		const content = readFile("src/server/routes/setup.ts");
		const claudeBlocks = extractQuotedListBlocks(content, /(?<![A-Z_])EVENTS=\(/, ")");
		const codexBlocks = extractQuotedListBlocks(content, /CODEX_EVENTS=\(/, ")");
		claudeBlocks.forEach((events, i) => {
			results.push({
				site: `src/server/routes/setup.ts (template ${i + 1})`,
				agent: "claude",
				events,
			});
		});
		codexBlocks.forEach((events, i) => {
			results.push({
				site: `src/server/routes/setup.ts (template ${i + 1})`,
				agent: "codex",
				events,
			});
		});
	}

	// scripts/install-local.ps1 — Claude is a flat @(...) array; Codex is a
	// hash-array of @{ event = "X"; ... } entries.
	{
		const content = readFile("scripts/install-local.ps1");
		const [claude] = extractQuotedListBlocks(content, /foreach \(\$eventName in @\(/, ")");
		const codex = extractKeyValueListBlock(
			content,
			/\$codexHooks = @\{/,
			"Set-JsonFile -Path (Join-Path $codexDir",
		);
		results.push({ site: "scripts/install-local.ps1", agent: "claude", events: claude ?? [] });
		results.push({ site: "scripts/install-local.ps1", agent: "codex", events: codex });
	}

	// bin/cli.ts — TS array literals.
	{
		const content = readFile("bin/cli.ts");
		const [claude] = extractQuotedListBlocks(content, /const claudeEvents = \[/, "]");
		const [codex] = extractQuotedListBlocks(content, /const codexEvents = \[/, "]");
		results.push({ site: "bin/cli.ts", agent: "claude", events: claude ?? [] });
		results.push({ site: "bin/cli.ts", agent: "codex", events: codex ?? [] });
	}

	// src/web/pages/SetupPage.tsx — the in-app "Copy Config" ternary. Both
	// branches share one `hookEvents =` marker; extract each bracketed list
	// (Claude first, Codex second) directly rather than by nested markers.
	{
		const content = readFile("src/web/pages/SetupPage.tsx");
		const idx = content.search(/const hookEvents =/);
		if (idx === -1) throw new Error("hookEvents marker not found in SetupPage.tsx");
		const claudeStart = content.indexOf("[", idx);
		const claudeEnd = content.indexOf("]", claudeStart);
		const claude = [...content.slice(claudeStart, claudeEnd).matchAll(/"([A-Z][A-Za-z]+)"/g)].map(
			(m) => m[1],
		);
		const codexStart = content.indexOf("[", claudeEnd);
		const codexEnd = content.indexOf("]", codexStart);
		const codex = [...content.slice(codexStart, codexEnd).matchAll(/"([A-Z][A-Za-z]+)"/g)].map(
			(m) => m[1],
		);
		results.push({ site: "src/web/pages/SetupPage.tsx", agent: "claude", events: claude });
		results.push({ site: "src/web/pages/SetupPage.tsx", agent: "codex", events: codex });
	}

	const mismatches: string[] = [];
	for (const result of results) {
		const canonical = result.agent === "claude" ? claudeCanonical : codexCanonical;
		if (result.events.length === 0) {
			mismatches.push(
				`${result.site} [${result.agent}]: extracted zero events — extraction likely broken`,
			);
			continue;
		}
		if (!sameSet(result.events, canonical)) {
			mismatches.push(
				`${result.site} [${result.agent}]: ${describe(result.events)} does not match types.ts ${result.agent === "claude" ? "ClaudeCodeEvent" : "CodexEvent"} ${describe(canonical)}`,
			);
		}
	}

	if (mismatches.length > 0) {
		console.error("Hook-event-list parity check failed:\n");
		console.error(mismatches.join("\n\n"));
		console.error(
			"\nAll seven wiring sites (scripts/setup-hooks.sh, scripts/setup-relay.sh, " +
				"src/server/routes/setup.ts x2 templates, scripts/install-local.ps1, bin/cli.ts, " +
				"src/web/pages/SetupPage.tsx) must register the exact same event set as the " +
				"src/shared/types.ts ClaudeCodeEvent / CodexEvent unions.",
		);
		process.exit(1);
	}

	console.log(
		`OK: hook-event lists match across all ${results.length / 2} wiring sites (Claude: ${describe(claudeCanonical)}, Codex: ${describe(codexCanonical)})`,
	);
}

main();
