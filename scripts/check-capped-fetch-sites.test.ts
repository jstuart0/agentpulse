import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ALLOWED_BARE_FETCH_FILES,
	checkCappedFetchSites,
	collectBareFetchFiles,
} from "./check-capped-fetch-sites.js";

const REAL_ROOT = join(import.meta.dir, "..");
let temp: string | null = null;
afterEach(() => {
	if (temp) rmSync(temp, { recursive: true, force: true });
	temp = null;
});

function tree(files: Record<string, string>): string {
	temp = mkdtempSync(join(tmpdir(), "ap-fetch-guard-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(temp, path)), { recursive: true });
		writeFileSync(join(temp, path), text);
	}
	return temp;
}

describe("check-capped-fetch-sites", () => {
	test("the repository is exactly the allowlist", () => {
		expect(collectBareFetchFiles(REAL_ROOT)).toEqual([...ALLOWED_BARE_FETCH_FILES].sort());
		expect(checkCappedFetchSites(REAL_ROOT)).toEqual({ unexpected: [], gone: [] });
	});
	test("a bare fetch( in a new file fails", () => {
		const root = tree({
			"src/updater/new-thing.ts": "export const x = () => fetch('https://example.invalid');\n",
		});
		expect(checkCappedFetchSites(root).unexpected).toEqual(["src/updater/new-thing.ts"]);
		const proc = Bun.spawnSync(
			["bun", join(REAL_ROOT, "scripts", "check-capped-fetch-sites.ts"), "--root", root],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(proc.exitCode).toBe(1);
		expect(proc.stderr.toString()).toContain("src/updater/new-thing.ts");
	});
	test("a default of `?? fetch` counts, a method named fetch and a capped fetch don't", () => {
		const root = tree({
			"src/server/a.ts": "export const f = (o: { fetch?: typeof fetch }) => o.fetch ?? fetch;\n",
			"src/server/b.ts":
				"export const g = (app: unknown) => (app as { fetch: () => void }).fetch();\n",
			"src/server/c.ts":
				"import { fetchCapped } from '../shared/capped-fetch.js'; export const h = () => fetchCapped('x', { deadlineMs: 1, maxBytes: 1 });\n",
			"src/server/d.test.ts": "fetch('x');\n",
		});
		expect(collectBareFetchFiles(root)).toEqual(["src/server/a.ts"]);
	});
});
