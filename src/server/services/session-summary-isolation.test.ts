/**
 * AGEN-69 phase 5: the summary service reaches nothing it should not (TC-5.34, 5.35, 5.36).
 *
 * Source scans, no database. TC-5.36 is `prompt-ownership-leak.test.ts`, which already scans
 * `src/server/services/ai`; the service's own session reads are checked here as well.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SERVICE = "src/server/services/session-summary-service.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (name === "node_modules" || name === "dist" || name === ".git") continue;
			sourceFiles(full, out);
		} else if (/\.(ts|tsx)$/.test(name)) out.push(full);
	}
	return out;
}

const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|(?:^|\W)import\(\s*["']([^"']+)["']\s*\)/g;

/** Every module `file` imports, as a specifier. */
function specifiers(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

interface Fs {
	read(file: string): string;
	exists(file: string): boolean;
}
const realFs: Fs = { read: (f) => readFileSync(f, "utf8"), exists: existsSync };

function resolveRelative(from: string, spec: string, fs: Fs): string | null {
	const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
	for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")])
		if (fs.exists(candidate)) return candidate;
	return null;
}

const FORBIDDEN_BARE = /^(node:)?(fs|fs\/promises|child_process)$/;
/** The database client is the one module the whole server reaches the filesystem through (it makes the SQLite file's directory). */
const SANCTIONED_FS_IMPORTERS = ["src/server/db/client.ts"];

/**
 * Walks the relative imports from `entry` and returns what the closure does wrong: a module
 * that imports the filesystem (other than the sanctioned database client), or any module
 * under src/supervisor. `files` is the size of the closure.
 */
function reachOffences(
	entry: string,
	root: string,
	fs: Fs = realFs,
): { files: number; offences: string[] } {
	const seen = new Set<string>();
	const offences: string[] = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const name = relative(root, file);
		if (name.startsWith(join("src", "supervisor"))) offences.push(`reaches ${name}`);
		for (const spec of specifiers(fs.read(file))) {
			if (spec.startsWith(".")) {
				const next = resolveRelative(file, spec, fs);
				if (next) queue.push(next);
			} else if (FORBIDDEN_BARE.test(spec) && !SANCTIONED_FS_IMPORTERS.includes(name)) {
				offences.push(`${name} imports ${spec}`);
			}
		}
	}
	return { files: seen.size, offences };
}

describe("TC-5.34 the service reaches no filesystem and nothing under src/supervisor", () => {
	test("the service's transitive imports include no node:fs outside the database client, and nothing under src/supervisor", () => {
		const { files, offences } = reachOffences(join(ROOT, SERVICE), ROOT);
		expect(files).toBeGreaterThan(10);
		expect(offences).toEqual([]);
	});

	test("the scanner sees a synthetic filesystem import, a synthetic supervisor reach, and lets the sanctioned client through", () => {
		const fake = new Map<string, string>([
			[
				"/r/src/server/a.ts",
				'import { x } from "./b.js";\nimport { readFileSync } from "node:fs";\nimport "./db/client.js";',
			],
			["/r/src/server/b.ts", 'import { y } from "../supervisor/c.js";'],
			["/r/src/supervisor/c.ts", "export const y = 1;"],
			["/r/src/server/db/client.ts", 'import { mkdirSync } from "node:fs";'],
		]);
		const fs: Fs = { read: (f) => fake.get(f) as string, exists: (f) => fake.has(f) };
		const result = reachOffences("/r/src/server/a.ts", "/r", fs);
		expect(result.offences.sort()).toEqual([
			"reaches src/supervisor/c.ts",
			"src/server/a.ts imports node:fs",
		]);
		expect(result.files).toBe(4);
	});
});

/** Files (relative to `root`) whose text names the table's runtime identifier. */
function tableReaders(files: Map<string, string>): string[] {
	return [...files.entries()]
		.filter(
			([name]) =>
				!/\.test\.tsx?$/.test(name) &&
				!name.includes("__fixtures__") &&
				!name.includes("/test-utils/"),
		)
		.filter(([, text]) => /\baiSessionSummaries/.test(text))
		.map(([name]) => name)
		.sort();
}

const EXPECTED_READERS = [
	"src/server/db/schema/ai/ai-session-summaries.ts",
	"src/server/db/schema/index.postgres.ts",
	"src/server/db/schema/index.sqlite.ts",
	"src/server/db/schema/index.ts",
	"src/server/services/retention-service.ts",
	SERVICE,
].sort();

describe("TC-5.35 one service owns the summary table", () => {
	test("the files naming aiSessionSummaries are the six expected; more than 200 files were scanned", () => {
		const files = new Map<string, string>();
		for (const f of sourceFiles(join(ROOT, "src")))
			files.set(relative(ROOT, f), readFileSync(f, "utf8"));
		expect(files.size).toBeGreaterThan(200);
		expect(tableReaders(files)).toEqual(EXPECTED_READERS);
	});

	test("the scanner flags a synthetic extra reader (a watcher, Q&A or search file)", () => {
		const files = new Map<string, string>([
			[SERVICE, "aiSessionSummaries"],
			[
				"src/server/services/ai/watcher-extra.ts",
				"const rows = db.select().from(aiSessionSummaries);",
			],
			["src/server/services/ai/fine.ts", "const x = 1;"],
			["src/server/services/ai/watcher-extra.test.ts", "aiSessionSummaries"],
		]);
		expect(tableReaders(files)).toEqual(
			["src/server/services/ai/watcher-extra.ts", SERVICE].sort(),
		);
	});
});

describe("TC-5.36 the service reads sessions through named columns", () => {
	test("no whole-row sessions select in the service or its helpers", () => {
		const text = readFileSync(join(ROOT, SERVICE), "utf8");
		expect(text).not.toMatch(/\.select\(\s*\)\s*\.from\(sessions\)/);
		expect(text).toMatch(/SESSION_COLUMNS_SANS_OWNERSHIP|select\(\{/);
	});
});
