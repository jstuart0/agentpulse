#!/usr/bin/env bun
/**
 * Tarball audit for the agentpulse-mcp package (Phase 4 of
 * thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md).
 *
 * The published npm tarball is the security boundary of publishing — a
 * `files: ["dist"]` allowlist in package.json rots silently without a gate,
 * and a PATH-only audit misses content embedded inside an otherwise
 * legitimately-named file (a `.js.map` with `sourcesContent` looks like a
 * normal build artifact by name alone). This script:
 *
 *   1. Rebuilds the package (`bun run build` — clean, per D4/X5: the build
 *      script itself does `rm -rf dist` first).
 *   2. Runs a REAL `npm pack` (not `--dry-run`) into a temp directory — the
 *      content checks below need the actual tarball bytes, not just
 *      `--dry-run`'s file list.
 *   3. Extracts it (via the `tar` CLI — present on every macOS/Linux CI
 *      runner) and asserts, over the real packed content:
 *
 *      (a) Path allowlist — every top-level entry is dist/, package.json,
 *          README.md, or LICENSE; zero `.ts` sources except `.d.ts`; no
 *          `*.test.*` / test-support / thoughts / `.env` files.
 *      (b) Sourcemap content (xander X1) — FAILS if ANY `*.map` file is
 *          packed at all (the build config emits none; presence means
 *          config drift), and additionally decodes any found and fails on
 *          a `sourcesContent` key (which would embed the full TypeScript
 *          source, including the D3 vendored-types header naming internal
 *          server file paths).
 *      (c) No lifecycle scripts (xander X4a) — the packed package.json
 *          must declare none of preinstall/install/postinstall/prepare/
 *          prepublish — the #1 npm supply-chain execution vector.
 *      (d) Content scan (xander X4b) — every packed file's CONTENT (not
 *          just its name) is scanned for secret/internal shapes: an
 *          AgentPulse API key (`ap_[A-Za-z0-9]{16,}`), a PEM/private-key
 *          block (`-----BEGIN`), the private homelab domain, and RFC-1918
 *          private-network addresses. Mirrors
 *          scripts/check-no-authentik-literals.ts's walk-then-pattern-match
 *          structure so a reviewer sees the same shape in both guards.
 *
 * Not part of check:architecture (the pre-commit fast chain) — this needs a
 * full build + a real npm pack, so it's wired as its own `check:mcp-tarball`
 * script and a dedicated CI step after the build.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG_DIR = join(ROOT, "packages", "agentpulse-mcp");

const ALLOWED_TOP_LEVEL = new Set(["dist", "package.json", "README.md", "LICENSE"]);
const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: "AgentPulse API key (ap_...)", re: /ap_[A-Za-z0-9]{16,}/ },
	{ name: "PEM / private-key block (-----BEGIN)", re: /-----BEGIN/ },
	{ name: "private homelab domain (xmojo.net)", re: /xmojo\.net/i },
	{
		name: "RFC-1918 private-network address",
		re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/,
	},
];

function run(cmd: string, args: string[], cwd: string): string {
	return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

function collectFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectFiles(full, base));
		} else if (entry.isFile()) {
			out.push(relative(base, full).split("\\").join("/"));
		}
	}
	return out;
}

async function main() {
	const violations: string[] = [];

	// 1. Clean rebuild.
	run("bun", ["run", "build"], PKG_DIR);

	// 2. Real npm pack into a temp dir.
	const tmpRoot = mkdtempSync(join(tmpdir(), "agentpulse-mcp-pack-"));
	let packMeta: { filename: string };
	try {
		const packOut = run("npm", ["pack", "--pack-destination", tmpRoot, "--json"], PKG_DIR);
		const parsed = JSON.parse(packOut);
		packMeta = parsed[0];
	} catch (err) {
		rmSync(tmpRoot, { recursive: true, force: true });
		throw new Error(
			`npm pack failed — is npm installed and on PATH? (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	const tarballPath = join(tmpRoot, packMeta.filename);
	const extractDir = join(tmpRoot, "extracted");
	mkdirSync(extractDir, { recursive: true });
	run("tar", ["-xzf", tarballPath, "-C", extractDir], tmpRoot);
	// npm always wraps the tarball's contents in a top-level "package/" dir.
	const pkgRoot = join(extractDir, "package");

	const allFiles = collectFiles(pkgRoot).sort();

	// (a) Path allowlist.
	for (const rel of allFiles) {
		const top = rel.split("/")[0];
		if (!ALLOWED_TOP_LEVEL.has(top)) {
			violations.push(`path-allowlist: unexpected top-level entry "${rel}"`);
			continue;
		}
		if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) {
			violations.push(`path-allowlist: raw TypeScript source shipped: ${rel}`);
		}
		if (
			/\.test\./.test(rel) ||
			rel.includes("test-support") ||
			rel.includes("thoughts") ||
			rel.endsWith(".env")
		) {
			violations.push(`path-allowlist: forbidden file shipped: ${rel}`);
		}
	}

	// (b) Sourcemap content.
	for (const rel of allFiles.filter((f) => f.endsWith(".map"))) {
		violations.push(
			`sourcemap: unexpected .map file present: ${rel} (build config should emit none — presence means config drift)`,
		);
		try {
			const decoded = JSON.parse(readFileSync(join(pkgRoot, rel), "utf8"));
			if (decoded.sourcesContent) {
				violations.push(
					`sourcemap: ${rel} embeds sourcesContent — the full TypeScript source (including internal server-path comments) would ship in the published package`,
				);
			}
		} catch {
			violations.push(`sourcemap: ${rel} could not be parsed as JSON`);
		}
	}

	// (c) No lifecycle scripts.
	const packedPkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};
	for (const key of LIFECYCLE_SCRIPT_KEYS) {
		if (packedPkgJson.scripts && key in packedPkgJson.scripts) {
			violations.push(
				`lifecycle-script: packed package.json declares "${key}": "${packedPkgJson.scripts[key]}" — the #1 npm supply-chain execution vector`,
			);
		}
	}

	// (d) Content scan (every packed file, not just filenames).
	for (const rel of allFiles) {
		const full = join(pkgRoot, rel);
		if (statSync(full).isDirectory()) continue;
		let content: string;
		try {
			content = readFileSync(full, "utf8");
		} catch {
			continue; // binary file — nothing to scan as text
		}
		for (const { name, re } of SECRET_PATTERNS) {
			if (re.test(content)) {
				violations.push(`content-scan: ${rel} matches "${name}" pattern`);
			}
		}
	}

	rmSync(tmpRoot, { recursive: true, force: true });

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: agentpulse-mcp tarball audit failed (${violations.length} violation${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
			].join("\n"),
		);
		process.exit(1);
	}

	console.log(
		`OK: agentpulse-mcp tarball (${packMeta.filename}, ${allFiles.length} files) passed all 4 audits — path allowlist, sourcemap content, lifecycle scripts, secret content scan.`,
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
