import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import fixture from "./__fixtures__/release-test-key.json";
import { RELEASE_KEYS } from "./release-keys.js";

const root = join(import.meta.dir, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.(ts|tsx|js|sh|yml)$/.test(name)) out.push(path);
	}
	return out;
}

describe("the release trust root never holds a test key", () => {
	test("release-keys.ts imports nothing, in particular no fixture", () => {
		const text = readFileSync(join(import.meta.dir, "release-keys.ts"), "utf-8");
		expect(text).not.toMatch(/^\s*import\b/m);
		expect(text).not.toMatch(/__fixtures__|release-test/);
		expect(text).not.toMatch(/PRIVATE KEY/);
	});

	test("no production key is a test key", () => {
		const testIds = new Set(
			Object.values(fixture).flatMap((k) =>
				typeof k === "string" ? [] : [k.keyId, k.publicKeyRaw],
			),
		);
		for (const key of RELEASE_KEYS) {
			expect(testIds.has(key.keyId)).toBe(false);
			expect(testIds.has(key.publicKeyRaw)).toBe(false);
		}
	});

	test("only test files import the fixture or the test signer", () => {
		const offenders: string[] = [];
		for (const dir of ["src", "scripts", "bin", "packages"]) {
			for (const file of sourceFiles(join(root, dir))) {
				const rel = relative(root, file);
				// A test-utils/ directory is test code: check-no-test-seam-leaks.ts fails if production imports anything from one.
				if (
					/\.test\.ts$/.test(rel) ||
					rel.includes("__fixtures__/release-test-") ||
					rel.includes("/test-utils/")
				) {
					continue;
				}
				if (/release-test-(key|signer)/.test(readFileSync(file, "utf-8"))) offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
