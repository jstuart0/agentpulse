import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const text = readFileSync(join(import.meta.dir, "..", "..", ".github", "CODEOWNERS"), "utf-8");

interface Rule {
	pattern: string;
	owners: string[];
}

const rules: Rule[] = text
	.split("\n")
	.map((l) => l.trim())
	.filter((l) => l !== "" && !l.startsWith("#"))
	.map((l) => {
		const [pattern, ...owners] = l.split(/\s+/);
		return { pattern: pattern as string, owners };
	});

/** The CODEOWNERS pattern forms this file uses: `/dir/`, `/file`. Last match wins, as on GitHub. */
function matches(pattern: string, path: string): boolean {
	const anchored = pattern.replace(/^\//, "");
	return pattern.endsWith("/") ? path.startsWith(anchored) : path === anchored;
}

function ownersOf(path: string): string[] {
	return [...rules].reverse().find((rule) => matches(rule.pattern, path))?.owners ?? [];
}

describe(".github/CODEOWNERS", () => {
	test("every rule has at least one owner, written as a GitHub handle", () => {
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) {
			expect(rule.owners.length, rule.pattern).toBeGreaterThan(0);
			for (const owner of rule.owners)
				expect(owner, rule.pattern).toMatch(/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/);
		}
	});

	const trustRoot = [
		".github/workflows/pages.yml",
		".github/workflows/release.yml",
		".github/workflows/mcp-release.yml",
		".github/CODEOWNERS",
		"releases/release-data.json",
		"scripts/release/sign-guard.ts",
		"scripts/release/build-manifest.ts",
		"src/shared/release-keys.ts",
		"src/shared/release-manifest.ts",
		"src/shared/relay-installer-parts.ts",
	];
	for (const path of trustRoot) {
		test(`${path} has an owner (named member: src/shared/release-keys.ts)`, () => {
			expect(ownersOf(path).length).toBeGreaterThan(0);
		});
	}

	test("an unrelated file isn't swept in by accident", () => {
		expect(ownersOf("src/web/pages/DashboardPage.tsx")).toEqual([]);
	});
});
