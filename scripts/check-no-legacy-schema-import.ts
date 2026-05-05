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

// Files allowed to import from the legacy shim (the shim itself, and client.ts
// which uses `import * as schema from "./schema.js"` for the Drizzle schema
// parameter — that import is definitionally the shim owner, not a consumer).
const FILE_ALLOWLISTED_SUFFIXES = [
	"src/server/db/schema.ts", // the shim itself
	"src/server/db/client.ts", // owns the shim; imports schema for Drizzle init
];

/**
 * Existing legacy callers (as of 2026-05-05 postgres-backend campaign).
 * These emit WARNINGS (non-fatal) while the migration campaign is in progress.
 * Any file NOT in this list that introduces a new shim import is a hard ERROR.
 *
 * When you migrate a file, remove it from this list.
 * When the list is empty, remove EXISTING_SHIM_USERS and turn all violations into hard errors.
 */
const EXISTING_SHIM_USERS = new Set([
	"src/server/auth/api-key.ts",
	"src/server/auth/supervisor-auth.ts",
	"src/server/routes/ai-watcher.ts",
	"src/server/routes/auth.ts",
	"src/server/routes/launches.ts",
	"src/server/routes/projects.ts",
	"src/server/routes/sessions.ts",
	"src/server/routes/settings.ts",
	"src/server/routes/templates.ts",
	"src/server/services/ai/action-requests-service.ts",
	"src/server/services/ai/action-requests-types.ts",
	"src/server/services/ai/alert-rule-evaluator.ts",
	"src/server/services/ai/digest-service.ts",
	"src/server/services/ai/embeddings/embedding-service.ts",
	"src/server/services/ai/event-queries.ts",
	"src/server/services/ai/feature.ts",
	"src/server/services/ai/hitl-service.ts",
	"src/server/services/ai/inbox-service.ts",
	"src/server/services/ai/inbox-snooze-service.ts",
	"src/server/services/ai/intelligence-service.ts",
	"src/server/services/ai/launch-recommender.ts",
	"src/server/services/ai/proposals-service.ts",
	"src/server/services/ai/providers-service.ts",
	"src/server/services/ai/risk-classes.ts",
	"src/server/services/ai/runner.ts",
	"src/server/services/ai/spend-service.ts",
	"src/server/services/ai/template-distillation.ts",
	"src/server/services/ai/watcher-config-service.ts",
	"src/server/services/ai/watcher-runs-service.ts",
	"src/server/services/ask/ask-add-project-handler.ts",
	"src/server/services/ask/ask-bulk-action-handler.ts",
	"src/server/services/ask/ask-crud-handler.ts",
	"src/server/services/ask/ask-launch-handler.ts",
	"src/server/services/ask/ask-qa-handler.ts",
	"src/server/services/ask/ask-resolver.ts",
	"src/server/services/ask/ask-resume-handler.ts",
	"src/server/services/ask/ask-search-handler.ts",
	"src/server/services/ask/ask-service.ts",
	"src/server/services/ask/ask-session-action-handler.ts",
	"src/server/services/ask/context-builder.ts",
	"src/server/services/ask/launch-disambiguation-handler.ts",
	"src/server/services/ask/launch-intent-detector.ts",
	"src/server/services/ask/resolver.ts",
	"src/server/services/channels/channels-service.ts",
	"src/server/services/channels/telegram-credentials.ts",
	"src/server/services/control-actions.ts",
	"src/server/services/event-processor.ts",
	"src/server/services/labs-service.ts",
	"src/server/services/launch-dispatch.ts",
	"src/server/services/launch-validator.ts",
	"src/server/services/local-auth-bootstrap.ts",
	"src/server/services/local-auth-service.ts",
	"src/server/services/managed-session-state.ts",
	"src/server/services/projects/cache.ts",
	"src/server/services/projects/projects-service.ts",
	"src/server/services/search/postgres-search-backend.ts",
	"src/server/services/session-tracker.ts",
	"src/server/services/settings-service.ts",
	"src/server/services/supervisor-registry.ts",
	"src/server/services/telemetry.ts",
	"src/server/services/templates/template-project-resolver.ts",
	"src/server/services/templates/templates-service.ts",
	"src/server/services/transcript-sync.ts",
	"src/server/services/workspace/feature.ts",
]);

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
