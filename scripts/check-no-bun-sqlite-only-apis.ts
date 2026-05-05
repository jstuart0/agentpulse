#!/usr/bin/env bun
/**
 * Architecture guard: bun-sqlite-only Drizzle API shapes must not appear
 * outside the explicitly allowed files.
 *
 * Disallowed patterns (outside allowlist):
 *   .run()           — bun-sqlite Drizzle statement executor on direct db calls
 *   .all()           — bun-sqlite Drizzle statement "return all rows" on direct db calls
 *   .get()           — bun-sqlite Drizzle statement "return first row" on direct db calls
 *   getDb().transaction(   — sync transaction (bun-sqlite-only call shape)
 *
 * Approved exception: `tx.something(...).run()`, `tx.something(...).all()`,
 * and `tx.something(...).get()` inside a `withTransaction()` callback are
 * the REQUIRED pattern for SQLite-safe transactions (bun-sqlite's Drizzle
 * adapter commits before async work settles; only sync tx.* forms guarantee
 * rollback). The patterns below exclude lines where `tx.` precedes the sync
 * call — those are inside a withTransaction callback and are correct.
 *
 * Allowlisted files (may use these APIs by design):
 *   src/server/db/client.ts                  — DB adapter definition
 *   src/server/db/with-transaction.ts        — canonical sync-tx helper (documents patterns)
 *   src/server/db/__test_db.ts               — test helper (if present)
 *   src/server/services/ai/__test_db.ts      — legacy test helper location
 *   src/server/services/search/sqlite-fts-backend.ts — SQLite FTS5 backend
 *   Any file matching *.test.ts              — tests retain raw access
 *
 * Phase 1 update: the 5 Phase 0 carry-over files (auth.ts, sessions.ts,
 * session-tracker.ts, projects-service.ts, control-actions.ts) are now
 * ported to withTransaction() and removed from the allowlist. They still use
 * tx.* sync forms inside withTransaction callbacks — those are excluded by
 * the tx-prefix exception in the patterns below.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const ALLOWLISTED_SUFFIXES = [
	// Core DB adapter and test helpers
	"src/server/db/client.ts",
	// The withTransaction helper is the canonical DB-layer file for sync-tx
	// semantics. Its docstring documents the .run()/.all()/.get() patterns by
	// design; its implementation uses them to bridge the bun-sqlite sync path.
	"src/server/db/with-transaction.ts",
	"src/server/db/__test_db.ts",
	"src/server/services/ai/__test_db.ts",
	"src/server/services/search/sqlite-fts-backend.ts",
	// Phase 0 carry-over (fully resolved in Phase 1): the 5 files that used
	// sync transaction callbacks are now ported to withTransaction() and
	// removed from this allowlist. Their remaining tx.* sync calls inside
	// withTransaction callbacks are excluded by the tx-prefix exception in
	// the pattern matcher (see PATTERNS below).
];

function isAllowlisted(relPath: string): boolean {
	// Tightened (xander mid-build M1): only `.test.ts` files inside src/ are
	// allowlisted, AND only when they sit alongside production code (not in
	// production route/service paths that happen to use a `.test.ts` suffix
	// for evasion). The walker already scopes to src/, so the prefix check
	// is belt-and-suspenders. Future tightening could require __tests__/ or
	// a dedicated tests/ directory, but the codebase convention is co-located
	// `*.test.ts` next to the file under test.
	if (relPath.startsWith("src/") && relPath.endsWith(".test.ts")) return true;
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

// Lines where the sync call is on the `tx` transaction variable are permitted.
// These appear inside withTransaction() callbacks, which is the approved
// abstraction for SQLite-safe transactions. The `tx` variable name is the
// codebase convention for the transaction parameter; direct db.* or getDb().*
// chains remain prohibited.
function isApprovedTxCall(line: string): boolean {
	// A line is an approved tx call if it contains a `tx.` chain ending in
	// .run()/.all()/.get() — meaning the sync call is on the transaction
	// variable rather than on a direct db access. This covers:
	//   tx.update(...).run()
	//   tx.select(...).all()
	//   tx.select(...).get()
	//   const rows = tx.select(...).all()
	//   const n = tx.select(...).all().length
	return /\btx\./.test(line);
}

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
			// Skip lines that are approved tx.* calls inside withTransaction callbacks.
			if (isApprovedTxCall(line)) continue;
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
