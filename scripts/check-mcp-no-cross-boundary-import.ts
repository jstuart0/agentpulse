#!/usr/bin/env bun
/**
 * Self-containment tripwire (2026-07-23-deliver-agentpulse-mcp-package
 * Phase 2 step 4): src/mcp/ must never import from the app's src/server/ or
 * src/shared/ trees. Phase 2 severs that coupling by vendoring types.ts +
 * scope-constants.ts; this guard keeps the severance honest until Phase 3
 * moves the directory into packages/agentpulse-mcp/src (at which point it's
 * repointed to scan the new root — the guard then also protects the
 * published package's boundary against a future edit accidentally
 * reintroducing a same-repo-only import path).
 *
 * Matches `from "../server/...")` / `from "../shared/...")` (any import
 * depth) but NOT a same-directory-tree sibling like `../server.js` (the
 * co-located src/mcp/server.ts, referenced from src/mcp/tools/*.ts) —
 * the distinguishing signal is a `/` immediately after `server`/`shared`,
 * i.e. a path INTO a directory, not a bare `.js` file one level up.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MCP_DIR = "src/mcp";
const VIOLATION_RE = /from\s+["'](\.\.\/)+(server|shared)\//;

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
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			yield full;
		}
	}
}

async function main() {
	const scanDir = join(ROOT, MCP_DIR);
	const violations: string[] = [];

	for await (const filePath of walkTs(scanDir)) {
		const rel = relative(ROOT, filePath);
		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			if (VIOLATION_RE.test(lines[i])) {
				violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
			}
		}
	}

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: cross-boundary import(s) found under ${MCP_DIR}/ (${violations.length} hit${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
				"",
				`${MCP_DIR}/ must be self-contained — it is extracted into the standalone`,
				"agentpulse-mcp npm package and cannot import from the app's src/server/",
				"or src/shared/ trees. Vendor the type/constant into ./types.ts or",
				"./scope-constants.ts instead (see the header comment on each file).",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log(`OK: no cross-boundary src/server or src/shared imports found under ${MCP_DIR}/`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
