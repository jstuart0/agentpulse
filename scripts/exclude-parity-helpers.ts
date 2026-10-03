/**
 * Shared helpers between the shell (sh/dash/bash --posix/busybox sh) and
 * PowerShell parity harnesses (scripts/exclude-shim-parity.test.ts and
 * scripts/exclude-shim-parity-ps.test.ts). Both
 * harnesses need the same "stand in a real temp directory for the
 * fixture matrix's synthetic /a prefix" rewrite; this used to be copy-
 * pasted between them, which meant a fix to one wouldn't reach the
 * other. One copy, imported by both.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExcludeFixtureCase } from "../src/shared/exclude-rules.js";

export function loadFixtures(): ExcludeFixtureCase[] {
	const fixturesRaw = readFileSync(
		join(import.meta.dir, "..", "src", "shared", "__fixtures__", "exclude-cases.json"),
		"utf-8",
	);
	return JSON.parse(fixturesRaw).cases;
}

export function tempHome(prefix = "ap-shim-home-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function rawContentFor(fixture: ExcludeFixtureCase): string | undefined {
	if (fixture.rulesFileLinesRaw !== undefined) return fixture.rulesFileLinesRaw;
	if (fixture.rulesFileLines !== undefined) return `${fixture.rulesFileLines.join("\n")}\n`;
	return undefined;
}

export function rewriteUnderHome(
	cwd: string | null | undefined,
	fixtureHome: string | undefined,
	realHome: string,
): string | null {
	if (cwd === undefined || cwd === null) return null;
	if (fixtureHome && cwd.startsWith(fixtureHome)) return realHome + cwd.slice(fixtureHome.length);
	return cwd;
}

/**
 * Unlike the TypeScript suite (which never actually chdirs anywhere — a
 * nonexistent path just makes `realpath` fall back gracefully), running a
 * REAL shell or PowerShell process needs a REAL, existing starting
 * directory. Most fixtures use a synthetic `/a/...` prefix as a stand-in
 * for "some absolute path", never created on disk by the TypeScript suite
 * either — this rewrites that one prefix onto a fresh per-test sandbox
 * directory (NEVER the literal `/a` at the real filesystem root, which
 * this must never create) so the interpreter actually has somewhere real
 * to start from. Applied identically to rule lines and to cwd so their
 * relative structure — what matters for the match — is preserved.
 */
export function rewriteForShell(value: string, sandboxRoot: string): string {
	return value.startsWith("/a/") || value === "/a" ? sandboxRoot + value : value;
}

export function rewriteRawContentForShell(raw: string, sandboxRoot: string): string {
	return raw.replace(/\/a(\/|$)/g, `${sandboxRoot}/a$1`);
}

export function isFixtureApplicable(
	fixture: ExcludeFixtureCase,
	platform: NodeJS.Platform,
): boolean {
	if (fixture.platform === "any") return true;
	if (fixture.platform === "posix") return platform !== "win32";
	return fixture.platform === platform;
}

export function cwdHasDotSegment(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	return cwd.split("/").some((seg) => seg === "." || seg === "..");
}
