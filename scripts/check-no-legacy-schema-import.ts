#!/usr/bin/env bun
/**
 * Architecture guard: production code must not import from the deprecated
 * db/schema.js shim barrel. Callers should import from db/schema/index.js
 * or specific subpaths (db/schema/core/..., db/schema/ai/..., etc.).
 *
 * ENFORCEMENT MODE:
 *   - Files in EXISTING_SHIM_USERS are KNOWN legacy callers. They are warned
 *     about (non-fatal) during the migration campaign so the build doesn't
 *     block at ~64 pre-existing violations.
 *   - Any file NOT in EXISTING_SHIM_USERS that imports from db/schema.js is
 *     a NEW violation and is treated as a hard error (exits 1). This ensures
 *     the legacy shim never gains new consumers while existing ones are being
 *     migrated.
 *
 * See thoughts/postgres-followup-plans/sqlite-legacy-init-removal.md for the
 * exit criterion (Decision 13 / dexter L-2). Once all files in EXISTING_SHIM_USERS
 * have been migrated, remove them from this list and set WARN_ONLY = false
 * to enforce the guard globally.
 *
 * Allowed import patterns:
 *   from "../db/schema/index.js"        ✅ canonical barrel
 *   from "../db/schema/core/sessions.js" ✅ specific subpath
 *   from "../db/schema/ai/providers.js"  ✅ specific subpath
 *
 * Disallowed (shim) pattern:
 *   from "../db/schema.js"              ❌ deprecated shim
 *   from "../../db/schema.js"           ❌ same shim at a different depth
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Files allowed to import from the legacy shim pattern (none remain after the
// 2026-05-05 migration campaign). The shim has been deleted and client.ts
// now imports from schema/index.js directly.
const FILE_ALLOWLISTED_SUFFIXES: string[] = [];

/**
 * Migration complete as of 2026-05-05 (schema-importer-migration campaign).
 * All 64 previously-listed callers have been migrated to db/schema/index.js.
 * The shim (db/schema.ts) has been deleted. This set is intentionally empty;
 * any file importing from db/schema.js is now a hard error (no grace period).
 */
const EXISTING_SHIM_USERS = new Set<string>();

// Match: from ".../<anything>/db/schema.js" (with or without .js extension),
// but NOT subpaths like db/schema/index.js, db/schema/core/..., db/schema/ai/...
// The negative lookahead on `/` ensures we don't flag subdirectory imports.
const LEGACY_SCHEMA_RE = /from\s+["'][^"']*\/db\/schema(?:\.js)?["']/;
// Also match the short relative form used inside the db/ directory itself
// (e.g. from "./schema.js" or from "./schema").
const LEGACY_SCHEMA_SHORT_RE = /from\s+["']\.\/schema(?:\.js)?["']/;

function isFileAllowlisted(relPath: string): boolean {
	if (relPath.endsWith(".test.ts")) return true; // tests may import anything
	return FILE_ALLOWLISTED_SUFFIXES.some(
		(suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`),
	);
}

function isKnownLegacyUser(relPath: string): boolean {
	return EXISTING_SHIM_USERS.has(relPath);
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
	const warnings: string[] = []; // existing callers — non-fatal
	const errors: string[] = []; // new callers — hard error

	for await (const filePath of walkTs(srcDir)) {
		const rel = relative(ROOT, filePath);
		if (isFileAllowlisted(rel)) continue;

		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (LEGACY_SCHEMA_RE.test(line) || LEGACY_SCHEMA_SHORT_RE.test(line)) {
				const entry = `${rel}:${i + 1}: legacy db/schema shim import\n  ${line.trim()}`;
				if (isKnownLegacyUser(rel)) {
					warnings.push(entry);
				} else {
					errors.push(entry);
				}
			}
		}
	}

	if (warnings.length > 0) {
		console.warn(
			[
				`WARNING: legacy db/schema shim imports in known migration targets (${warnings.length} hit${warnings.length === 1 ? "" : "s"}):`,
				"",
				...warnings,
				"",
				"Migrate these imports to db/schema/index.js or specific subpaths.",
				"Remove each file from EXISTING_SHIM_USERS in scripts/check-no-legacy-schema-import.ts when done.",
				"(Decision 13: shim retained for one release; these warnings are expected during migration)",
			].join("\n"),
		);
	}

	if (errors.length > 0) {
		console.error(
			[
				`ERROR: new legacy db/schema shim import(s) detected (${errors.length} hit${errors.length === 1 ? "" : "s"}):`,
				"",
				...errors,
				"",
				"These files are NOT in the known legacy list — they introduced NEW shim imports.",
				"Import from db/schema/index.js or a specific subpath instead.",
				"If this is a known pre-existing file, add it to EXISTING_SHIM_USERS in",
				"scripts/check-no-legacy-schema-import.ts (with a comment explaining why).",
			].join("\n"),
		);
		process.exit(1);
	}

	if (warnings.length === 0 && errors.length === 0) {
		console.log("OK: no legacy db/schema shim imports found");
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
