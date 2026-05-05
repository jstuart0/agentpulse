#!/usr/bin/env bun
/**
 * Architecture guard: production code must not import from the deprecated
 * db/schema.js shim barrel. Callers should import from db/schema/index.js
 * or specific subpaths (db/schema/core/..., db/schema/ai/..., etc.).
 *
 * WARNING MODE: during the `2026-05-05-deliver-postgres-backend` campaign,
 * the db/schema.ts shim is retained for one release per Decision 13 (ian H1
 * deferral). This guard reports existing violations as warnings rather than
 * errors so that CI passes during the transition period. The shim will be
 * removed in the follow-up cleanup release; at that point, change WARN_ONLY
 * to false to enforce the guard as a hard error.
 *
 * See thoughts/postgres-followup-plans/sqlite-legacy-init-removal.md for the
 * exit criterion (Decision 13 / dexter L-2).
 *
 * Allowed import patterns:
 *   from "../db/schema/index.js"        ✅ canonical barrel
 *   from "../db/schema/core/sessions.js" ✅ specific subpath
 *   from "../db/schema/ai/providers.js"  ✅ specific subpath
 *
 * Disallowed (shim) pattern:
 *   from "../db/schema.js"              ⚠️  deprecated shim (warn now; error after cleanup)
 *   from "../../db/schema.js"           ⚠️  same shim at a different depth
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Set to false to turn warnings into hard errors (after the shim is removed).
const WARN_ONLY = true;

const ROOT = new URL("..", import.meta.url).pathname;

// Files allowed to import from the legacy shim (the shim itself, and client.ts
// which uses `import * as schema from "./schema.js"` for the Drizzle schema
// parameter — that import is definitionally the shim owner, not a consumer).
const ALLOWLISTED_SUFFIXES = [
	"src/server/db/schema.ts", // the shim itself
	"src/server/db/client.ts", // owns the shim; imports schema for Drizzle init
];

// Match: from ".../<anything>/db/schema" or from "./schema.js" (not schema/...)
// The negative lookahead ensures we don't flag `db/schema/index` or `db/schema/core/`.
const LEGACY_SCHEMA_RE = /from\s+["'][^"']*\/db\/schema(?!\/|\/index)["']/;
// Also match the short relative form used inside the db/ directory itself.
const LEGACY_SCHEMA_SHORT_RE = /from\s+["']\.\/schema(?!\/|\/index)["']/;

function isAllowlisted(relPath: string): boolean {
	if (relPath.endsWith(".test.ts")) return true; // tests may import anything
	return ALLOWLISTED_SUFFIXES.some(
		(suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`),
	);
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
			if (LEGACY_SCHEMA_RE.test(line) || LEGACY_SCHEMA_SHORT_RE.test(line)) {
				hits.push(`${rel}:${i + 1}: legacy db/schema shim import\n  ${line.trim()}`);
			}
		}
	}

	if (hits.length === 0) {
		console.log("OK: no legacy db/schema shim imports found");
		return;
	}

	const message = [
		`Legacy db/schema shim imports detected (${hits.length} hit${hits.length === 1 ? "" : "s"}):`,
		"",
		...hits,
		"",
		"Migrate these imports to db/schema/index.js or specific subpaths.",
		"See thoughts/postgres-followup-plans/sqlite-legacy-init-removal.md",
		"(Decision 13: shim retained for one release; this guard is warn-only during transition)",
	].join("\n");

	if (WARN_ONLY) {
		console.warn(`WARNING: ${message}`);
		// Exit 0 — warn-only during transition period (Decision 13 / ian H1 deferral).
		// Change WARN_ONLY to false once the shim is removed.
	} else {
		console.error(`ERROR: ${message}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
