/**
 * Static isolation proof for cli.ts's dispatcher (codex r2 CR1, reconcile
 * pass on thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md).
 *
 * `agentpulse-mcp install`/`--help` must never eagerly load the MCP SDK or
 * any tool file — only `serve` needs those. A static source-text scan is
 * the right tool here (not a runtime spy): the property being guarded is
 * structural (what's statically imported at module scope vs. what's only
 * reachable via a per-branch dynamic import), the same rationale
 * check-no-console-log-mcp.ts and check-mcp-no-raw-register-tool.ts use
 * for their own structural invariants.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_SRC = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
const CLI_COMMANDS_SRC = readFileSync(join(import.meta.dir, "cli-commands.ts"), "utf8");

// Matches a static `import ... from "..."` at module scope. `import type`
// is exempt (erased at compile time — zero runtime module load).
const STATIC_VALUE_IMPORT_RE = /^import\s+(?!type\s)[^;]*from\s+["'][^"']+["'];?\s*$/gm;

describe("cli.ts dispatcher isolation (codex r2 CR1)", () => {
	test("cli.ts has zero static top-level value imports — only per-branch dynamic import()", () => {
		const staticImports = CLI_SRC.match(STATIC_VALUE_IMPORT_RE) ?? [];
		expect(staticImports).toEqual([]);
	});

	test("cli.ts's only import of ./index.js (which pulls in the SDK + buildMcpServer's 7 tool files) is the single dynamic import in the serve branch", () => {
		const indexJsRefs = CLI_SRC.match(/import\(\s*["']\.\/index\.js["']\s*\)/g) ?? [];
		expect(indexJsRefs.length).toBe(1);
	});

	test("cli.ts never imports the MCP SDK directly", () => {
		expect(CLI_SRC).not.toMatch(/@modelcontextprotocol\/sdk/);
	});

	test("cli.ts contains zero console.log/console.debug/process.stdout.write calls (it's always loaded, regardless of subcommand — install/help output lives in cli-commands.ts instead)", () => {
		expect(CLI_SRC).not.toMatch(/console\.(log|debug)\s*\(/);
		expect(CLI_SRC).not.toMatch(/process\.stdout\.write\s*\(/);
	});

	test("cli-commands.ts (the install/help module, only reachable from cli.ts's non-serve branches) never imports the SDK, server.js, resources.js, index.js, or any tools/* file", () => {
		expect(CLI_COMMANDS_SRC).not.toMatch(/@modelcontextprotocol\/sdk/);
		expect(CLI_COMMANDS_SRC).not.toMatch(/from\s+["']\.\/(server|resources|index)\.js["']/);
		expect(CLI_COMMANDS_SRC).not.toMatch(/tools\//);
	});

	test("cli-commands.ts's only value imports are the four targeted install-path modules (client/errors/scopes/install) — mirrors bin/cli.ts's shim isolation", () => {
		const staticImports = (CLI_COMMANDS_SRC.match(STATIC_VALUE_IMPORT_RE) ?? []).join("\n");
		expect(staticImports).toMatch(/from\s+["']\.\/client\.js["']/);
		expect(staticImports).toMatch(/from\s+["']\.\/errors\.js["']/);
		expect(staticImports).toMatch(/from\s+["']\.\/install\.js["']/);
		expect(staticImports).toMatch(/from\s+["']\.\/scopes\.js["']/);
		// Exactly these four modules — no fifth import sneaking in.
		const importedModules = [...staticImports.matchAll(/from\s+["']\.\/([\w-]+)\.js["']/g)].map(
			(m) => m[1],
		);
		expect(new Set(importedModules)).toEqual(new Set(["client", "errors", "install", "scopes"]));
	});
});
