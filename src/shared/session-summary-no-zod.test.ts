import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const IMPORT_RE =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](zod(?:\/[^"']*)?|zod-[^"']*|@zod\/[^"']*)["']/;
/** Relative imports, and the `@server/`, `@web/` and `@shared/` aliases the tsconfig defines. */
const LOCAL_IMPORT_RE =
	/(?:from\s+|import\s*\(\s*|import\s+)["']((?:\.{1,2}\/|@(?:server|web|shared)\/)[^"']+)["']/g;
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\b/;
const ALIASES: Record<string, string> = {
	"@server/": "src/server/",
	"@web/": "src/web/",
	"@shared/": "src/shared/",
};

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
	const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a));
	const target = alias ? join(ROOT, ALIASES[alias] as string, spec.slice(alias.length)) : spec;
	const base = alias
		? target.replace(/\.js$/, "")
		: resolve(dirname(from), target.replace(/\.js$/, ""));
	for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Imports that survive compilation: a statement written `import type` or `export type` is erased. */
function runtimeImports(source: string): string[] {
	const found: string[] = [];
	for (const statement of source.split(/;\s*\n|\n(?=import |export )/)) {
		if (TYPE_ONLY_RE.test(statement)) continue;
		for (const match of statement.matchAll(LOCAL_IMPORT_RE)) found.push(match[1] as string);
	}
	return found;
}

/** Every file reachable from the entries through relative and alias imports that survive compilation. */
function closure(entries: string[]): string[] {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length > 0) {
		const file = stack.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
			const next = resolveImport(file, spec);
			if (next) stack.push(next);
		}
	}
	return [...seen];
}

describe("zod stays on the server", () => {
	test("TC-4.36a no file the web bundle can reach imports zod: the closure of src/web through relative and alias imports (more than 100 files)", () => {
		const entries = walk(join(ROOT, "src/web"));
		expect(entries.length).toBeGreaterThan(100);
		const reachable = closure(entries);
		expect(reachable.length).toBeGreaterThan(entries.length);
		const offenders = reachable.filter((f) => importsZod(readFileSync(f, "utf8")));
		expect(offenders.map((f) => f.slice(ROOT.length))).toEqual([]);
	});

	test("TC-4.36e the closure follows an alias and drops a type-only import", () => {
		expect(runtimeImports('import { a } from "@shared/session-summary.js";')).toEqual([
			"@shared/session-summary.js",
		]);
		expect(runtimeImports('import type { A } from "@server/db/client.js";')).toEqual([]);
		expect(runtimeImports('export type { A } from "../x.js";')).toEqual([]);
		expect(resolveImport(join(ROOT, "src/web/a.ts"), "@shared/session-summary.js")).toBe(
			join(ROOT, "src/shared/session-summary.ts"),
		);
	});

	test("TC-4.36b every src/shared file named session-summary*, and everything it imports at runtime under src/shared, is zod-free (P4-22)", () => {
		const entries = readdirSync(join(ROOT, "src/shared"))
			.filter((name) => name.startsWith("session-summary") && /\.tsx?$/.test(name))
			.filter((name) => !name.includes(".test."))
			.map((name) => join(ROOT, "src/shared", name));
		expect(entries.map((e) => e.slice(ROOT.length))).toContain("/src/shared/session-summary.ts");
		for (const file of closure(entries)) {
			expect(file.startsWith(join(ROOT, "src/shared")), file).toBe(true);
			expect(importsZod(readFileSync(file, "utf8")), file).toBe(false);
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
