#!/usr/bin/env bun
/**
 * Architecture guard (AGEN-12 Phase 2 mid-build hardening, dexter High):
 * every MCP tool registration must flow through registerReadTool /
 * registerMutatingTool (src/mcp/server.ts) so output.ts caps, errors.ts
 * mapping, and rUI/readOnlyHint stamping are structural rather than
 * per-call-site discipline. `ToolContext.server` is public (McpServer
 * instances need to be connect()-able), so nothing at the type level stops
 * a future tool file from calling `ctx.server.registerTool(...)` directly
 * and skipping the wrapper entirely.
 *
 * Statically scans src/mcp/**\/*.ts (excluding *.test.ts) for `.registerTool(`
 * and fails if it appears anywhere except src/mcp/server.ts (the wrappers'
 * own definitions, which necessarily call the SDK's real registerTool).
 * Modeled on check-no-console-log-mcp.ts. Run BEFORE Phase 3 fans out 16
 * read tools across new files under src/mcp/tools/, while there's exactly
 * one legitimate call site to allowlist.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const REGISTER_TOOL_RE = /\.registerTool\s*\(/;

// The wrappers' own definitions — the only files allowed to call the SDK's
// registerTool directly.
const ALLOWLISTED_FILES = new Set(["src/mcp/server.ts"]);

async function* walkTs(dir: string): AsyncGenerator<string> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTs(full);
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			yield full;
		}
	}
}

async function main() {
	const mcpDir = join(ROOT, "src", "mcp");
	const violations: string[] = [];

	for await (const filePath of walkTs(mcpDir)) {
		const rel = relative(ROOT, filePath);
		if (ALLOWLISTED_FILES.has(rel)) continue;

		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			if (REGISTER_TOOL_RE.test(lines[i])) {
				violations.push(
					`${rel}:${i + 1}: raw .registerTool() call bypasses registerReadTool/registerMutatingTool\n  ${lines[i].trim()}`,
				);
			}
		}
	}

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: raw .registerTool() call(s) found outside src/mcp/server.ts (${violations.length} hit${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
				"",
				"Every tool must register via registerReadTool() or registerMutatingTool()",
				"(src/mcp/server.ts) — never McpServer.registerTool() directly. This is what",
				"makes output caps, error mapping, and rUI/readOnlyHint stamping structural",
				"instead of per-call-site discipline.",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log("OK: no raw .registerTool() calls found outside src/mcp/server.ts");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
