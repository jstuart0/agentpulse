#!/usr/bin/env bun
/**
 * Architecture guard: bun-sqlite-only Drizzle API shapes must not appear
 * outside the explicitly allowed files.
 *
 * Disallowed patterns (outside allowlist):
 *   .run()           — bun-sqlite Drizzle statement executor
 *   .all()           — bun-sqlite Drizzle statement "return all rows"
 *   .get()           — bun-sqlite Drizzle statement "return first row"
 *   getDb().transaction(   — sync transaction (bun-sqlite-only call shape)
 *
 * Allowlisted files (may use these APIs by design):
 *   src/server/db/client.ts                  — DB adapter definition
 *   src/server/db/__test_db.ts               — test helper (if present)
 *   src/server/services/ai/__test_db.ts      — legacy test helper location
 *   src/server/services/search/sqlite-fts-backend.ts — SQLite FTS5 backend
 *   Any file matching *.test.ts              — tests retain raw access
 *
 * Phase 0 carry-over: the following files retain sync transaction callbacks
 * because bun-sqlite's Drizzle adapter commits before async callbacks settle,
 * silently disabling rollback. These will be converted in Phase 1 once the
 * dialect resolver can dispatch to sync (SQLite) or async (Postgres) callbacks.
 *   src/server/routes/auth.ts
 *   src/server/routes/sessions.ts
 *   src/server/services/session-tracker.ts
 *   src/server/services/projects/projects-service.ts
 *   src/server/services/control-actions.ts
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const ALLOWLISTED_SUFFIXES = [
	// Core DB adapter and test helpers
	"src/server/db/client.ts",
	"src/server/db/__test_db.ts",
	"src/server/services/ai/__test_db.ts",
	"src/server/services/search/sqlite-fts-backend.ts",
	// Phase 0 carry-over: sync transaction bodies required for bun-sqlite
	// rollback correctness; converted to async in Phase 1.
	"src/server/routes/auth.ts",
	"src/server/routes/sessions.ts",
	"src/server/services/session-tracker.ts",
	"src/server/services/projects/projects-service.ts",
	"src/server/services/control-actions.ts",
];

function isAllowlisted(relPath: string): boolean {
	if (relPath.endsWith(".test.ts")) return true;
	return ALLOWLISTED_SUFFIXES.some(
		(suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`),
	);
}

// Patterns that indicate bun-sqlite-only Drizzle API usage.
// We match on the call shape rather than full expression to avoid
// false-negatives from line-wrapping or intermediate variable usage.
const PATTERNS = [
	{ re: /\)\.run\(\)/, label: ".run() — bun-sqlite executor" },
	{ re: /\)\.all\(\)/, label: ".all() — bun-sqlite all-rows" },
	// .get() with no args is the bun-sqlite "first row" shape; exclude .get(key)
	// used by Map/Set etc. by requiring it to follow a closing paren (query chain).
	{ re: /\)\.get\(\)/, label: ".get() — bun-sqlite first-row" },
	// sync transaction: getDb().transaction( with a non-async callback
	// Match the call opener; false-positives from async tx are acceptable
	// (the async keyword in the callback makes them portable) — so we only
	// flag when the callback does NOT start with `async`.
	{
		re: /getDb\(\)\.transaction\(\s*(?!async\s*\()\(/,
		label: "sync getDb().transaction() — use async callback",
	},
];

async function* walkTs(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
			yield* walkTs(full);
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			yield full;
		}
	}
}

async function main() {
	const srcDir = join(ROOT, "src");
	const hits: string[] = [];

	for await (const filePath of walkTs(srcDir)) {
		const rel = relative(ROOT, filePath);
		if (isAllowlisted(rel)) continue;

		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const { re, label } of PATTERNS) {
				if (re.test(line)) {
					hits.push(`${rel}:${i + 1}: ${label}\n  ${line.trim()}`);
				}
			}
		}
	}

	if (hits.length > 0) {
		console.error(
			`bun-sqlite-only Drizzle API calls detected outside allowlisted files:\n\n${hits.join("\n\n")}`,
		);
		console.error(
			"\nPort these calls to portable async Drizzle APIs before adding Postgres support.",
		);
		process.exit(1);
	}

	console.log("OK: no bun-sqlite-only Drizzle API calls found outside allowlisted files");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
