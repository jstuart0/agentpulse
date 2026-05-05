#!/usr/bin/env bun
/**
 * Architecture guard: X-Authentik-* header literals must not appear in
 * production source outside the explicitly allowlisted files.
 *
 * After Phase 1+2 of the forwardauth-generic campaign, all X-Authentik-*
 * header reads in src/ go through config.forwardauthHeader() with Authentik
 * defaults. This guard prevents regressions where a new file hardcodes a
 * provider-specific header name directly.
 *
 * Scope: src/server/, src/web/, src/shared/ only.
 * NOT enforced on: deploy/, docs/, README.md, CLAUDE.md — manifests and docs
 * legitimately reference X-Authentik-* headers as default values.
 *
 * Allowlisted files (may contain X-Authentik-* header literals by design):
 *   src/server/config.ts           — default header values are documented here
 *   src/server/auth/middleware.ts  — legacy fallback comments
 *   Any *.test.ts file in src/     — tests use literal header names for clarity
 *
 * Pattern: /X-Authentik-/i (case-insensitive; matches the header form)
 * Note: the bare word "authentik" (e.g. provider === "authentik") does NOT
 * trigger this guard — it only fires on the HTTP header prefix form.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Files that legitimately contain X-Authentik-* header literals.
// Paths are relative to the repository root.
const ALLOWLISTED_SUFFIXES = [
	"src/server/config.ts",
	"src/server/auth/middleware.ts",
	// This script itself — avoid self-trigger on the pattern strings above.
	"scripts/check-no-authentik-literals.ts",
];

function isAllowlisted(relPath: string): boolean {
	// Test files in src/ are allowlisted — they use literal header names for
	// test clarity rather than config indirection.
	if (relPath.startsWith("src/") && relPath.endsWith(".test.ts")) return true;
	return ALLOWLISTED_SUFFIXES.some(
		(suffix) => relPath === suffix || relPath.endsWith(`/${suffix}`),
	);
}

// The pattern we're guarding: HTTP header form of Authentik-specific names.
// Bare word "authentik" (provider labels, log strings) is fine and not caught.
const PATTERN = /X-Authentik-/i;

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
			if (PATTERN.test(line)) {
				hits.push(`${rel}:${i + 1}:\n  ${line.trim()}`);
			}
		}
	}

	if (hits.length > 0) {
		console.error("X-Authentik-* header literals detected in src/ outside allowlisted files:\n");
		console.error(hits.join("\n\n"));
		console.error(
			"\nUse config.forwardauthHeader('<slot>') instead of hardcoding X-Authentik-* header names.",
		);
		console.error("Or add the file to ALLOWLISTED_SUFFIXES if the reference is intentional.");
		process.exit(1);
	}

	console.log("OK: no X-Authentik-* header literals found in src/ outside allowlisted files");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
