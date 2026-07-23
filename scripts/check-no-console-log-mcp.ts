#!/usr/bin/env bun
/**
 * Architecture guard (AGEN-12 Phase 2, test contract assertion 32; widened
 * per xander Low mid-build finding): the stdio MCP transport owns stdout
 * for the JSON-RPC protocol stream. A stray console.log/console.debug call,
 * or a bare process.stdout.write, anywhere under packages/agentpulse-mcp/src/
 * (retargeted from src/mcp/ by the 2026-07-23-deliver-agentpulse-mcp-package
 * extraction) would write non-protocol bytes to stdout and corrupt the
 * stream. Diagnostics must route through log.ts's stderrLog() instead.
 *
 * Two allowlisted files:
 *   - log.ts — the sanctioned home for stream-level diagnostics I/O (it
 *     writes to process.stderr, not stdout — allowlisted here purely so the
 *     raw process.stdout.write scan doesn't need to special-case "unless
 *     it's actually .stderr.write", which would make the regex fragile).
 *   - cli.ts — the package's bin entry point. Its `install` subcommand
 *     legitimately prints human-facing config output via console.log; this
 *     is safe because `install` and `serve` (the only stdout-owning path)
 *     are mutually exclusive branches of the same dispatch — console.log
 *     never executes while the stdio transport holds stdout.
 *
 * console.debug is included because it writes to stdout in Node/Bun just
 * like console.log — console.error/warn are fine (they write to stderr).
 *
 * Statically scans packages/agentpulse-mcp/src/**\/*.ts (excluding
 * *.test.ts). Recommended (over a runtime spy test) because the failure
 * mode this guards against — stdout corruption — is structural, not
 * behavioral; a static scan catches it the same way check-no-raw-fetch.sh
 * and check-no-legacy-schema-import.ts catch their respective structural
 * invariants.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CONSOLE_LOG_RE = /console\.(log|debug)\s*\(/;
const STDOUT_WRITE_RE = /process\.stdout\.write\s*\(/;

const ALLOWLISTED_FILES = new Set([
	"packages/agentpulse-mcp/src/log.ts",
	"packages/agentpulse-mcp/src/cli.ts",
]);

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
	const mcpDir = join(ROOT, "packages", "agentpulse-mcp", "src");
	const violations: string[] = [];

	for await (const filePath of walkTs(mcpDir)) {
		const rel = relative(ROOT, filePath);
		if (ALLOWLISTED_FILES.has(rel)) continue;

		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			if (CONSOLE_LOG_RE.test(lines[i])) {
				violations.push(
					`${rel}:${i + 1}: console.log()/console.debug() would corrupt the stdio protocol stream\n  ${lines[i].trim()}`,
				);
			}
			if (STDOUT_WRITE_RE.test(lines[i])) {
				violations.push(
					`${rel}:${i + 1}: raw process.stdout.write() would corrupt the stdio protocol stream\n  ${lines[i].trim()}`,
				);
			}
		}
	}

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: stdout-writing call(s) found under packages/agentpulse-mcp/src/ (${violations.length} hit${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
				"",
				"The stdio transport owns stdout for the JSON-RPC protocol stream.",
				"Use stderrLog() from log.ts for diagnostics instead.",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log(
		"OK: no console.log()/console.debug()/raw process.stdout.write() calls found under packages/agentpulse-mcp/src/ (outside the allowlist)",
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
