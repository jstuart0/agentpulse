import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const IMPORT_RE =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](zod(?:\/[^"']*)?|zod-[^"']*|@zod\/[^"']*)["']/;
const RELATIVE_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

function importsZod(source: string): boolean {
	return IMPORT_RE.test(source);
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|tsx)$/.test(name)) out.push(path);
	}
	return out;
}

function resolveImport(from: string, spec: string): string | null {
	const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
	for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Every file reachable from `entry` through relative imports. */
function closure(entry: string): string[] {
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(RELATIVE_RE)) {
			const next = resolveImport(file, match[1] as string);
			if (next) stack.push(next);
		}
	}
	return [...seen];
}

describe("zod stays on the server", () => {
	test("TC-4.36a no file under src/web imports zod (more than 100 visited)", () => {
		const files = walk(join(ROOT, "src/web"));
		expect(files.length).toBeGreaterThan(100);
		const offenders = files.filter((f) => importsZod(readFileSync(f, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("TC-4.36b src/shared/session-summary.ts and everything it imports under src/shared is zod-free", () => {
		const entry = join(ROOT, "src/shared/session-summary.ts");
		expect(existsSync(entry)).toBe(true);
		const reachable = closure(entry);
		expect(reachable.length).toBeGreaterThanOrEqual(1);
		for (const file of reachable) {
			expect(file.startsWith(join(ROOT, "src/shared"))).toBe(true);
			expect(importsZod(readFileSync(file, "utf8"))).toBe(false);
		}
	});

	test("TC-4.36c the scanner flags a synthetic offender in every import form", () => {
		for (const source of [
			'import { z } from "zod";',
			"import { z } from 'zod'",
			'import * as z from "zod/v4";',
			'const z = require("zod");',
			'const z = await import("zod");',
			'import "zod";',
		]) {
			expect(importsZod(source)).toBe(true);
		}
		expect(importsZod('import { zodiac } from "./zodiac.js";')).toBe(false);
		expect(importsZod("// we use zod on the server")).toBe(false);
	});

	test("TC-4.36d the validating schema is the server's: output-schema.ts imports zod", () => {
		const schema = readFileSync(
			join(ROOT, "src/server/services/ai/session-summary/output-schema.ts"),
			"utf8",
		);
		expect(importsZod(schema)).toBe(true);
	});
});
