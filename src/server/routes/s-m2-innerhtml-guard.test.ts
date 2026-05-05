// P8 — S-M2: guard test that ensures no new dangerouslySetInnerHTML
// usages appear in src/web without review.
//
// Current finding: exactly ONE usage exists in src/web/pages/SearchPage.tsx,
// guarded by sanitizeSnippet() which escapes all HTML except <mark>…</mark>
// (FTS5-generated, not user-controlled). This test documents and enforces
// that invariant — any new hit requires an explicit allowlist entry here.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// import.meta.dir is src/server/routes — go up three levels to repo root
const REPO_ROOT = join(import.meta.dir, "../../../");
const WEB_SRC = join(REPO_ROOT, "src/web");

// Files where dangerouslySetInnerHTML is intentionally used and has been
// reviewed. Adding a new file here requires a security review comment in
// the PR explaining why it's safe.
const ALLOWED_OCCURRENCES: Record<string, number> = {
	// FTS5 snippet — guarded by sanitizeSnippet(); reviewed P8.
	"src/web/pages/SearchPage.tsx": 1,
};

function walkFiles(dir: string, ext: string[]): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...walkFiles(full, ext));
		} else if (ext.some((e) => entry.endsWith(e))) {
			results.push(full);
		}
	}
	return results;
}

describe("S-M2 — dangerouslySetInnerHTML audit", () => {
	test("no unreviewed dangerouslySetInnerHTML in src/web", () => {
		const files = walkFiles(WEB_SRC, [".tsx", ".ts"]);
		const violations: string[] = [];

		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			const count = (content.match(/dangerouslySetInnerHTML/g) ?? []).length;
			if (count === 0) continue;

			// Normalize to repo-relative path for stable comparison.
			const relPath = file.slice(REPO_ROOT.length).replace(/\\/g, "/");
			const allowed = ALLOWED_OCCURRENCES[relPath] ?? 0;

			if (count > allowed) {
				violations.push(
					`${relPath}: found ${count} occurrence(s), allowed ${allowed}. Add to ALLOWED_OCCURRENCES with a security review comment.`,
				);
			}
		}

		expect(violations).toEqual([]);
	});
});
