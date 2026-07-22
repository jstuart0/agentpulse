#!/usr/bin/env bun
/**
 * Architecture guard (AGEN-12 Phase 2, test contract assertion 32): the
 * stdio MCP transport owns stdout for the JSON-RPC protocol stream. A
 * stray console.log call anywhere under src/mcp/ would write non-protocol
 * bytes to stdout and corrupt the stream. Diagnostics must route through
 * src/mcp/log.ts's stderrLog() instead.
 *
 * Statically scans src/mcp/**\/*.ts (excluding *.test.ts) for `console.log(`.
 * Recommended (over a runtime spy test) because the failure mode this
 * guards against — stdout corruption — is structural, not behavioral; a
 * static scan catches it the same way check-no-raw-fetch.sh and
 * check-no-legacy-schema-import.ts catch their respective structural
 * invariants.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CONSOLE_LOG_RE = /console\.log\s*\(/;

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
		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			if (CONSOLE_LOG_RE.test(lines[i])) {
				violations.push(
					`${rel}:${i + 1}: console.log() would corrupt the stdio protocol stream\n  ${lines[i].trim()}`,
				);
			}
		}
	}

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: console.log() found under src/mcp/ (${violations.length} hit${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
				"",
				"The stdio transport owns stdout for the JSON-RPC protocol stream.",
				"Use stderrLog() from src/mcp/log.ts for diagnostics instead.",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log("OK: no console.log() calls found under src/mcp/");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
