/**
 * AGEN-123 structural guard: the fields that hold what a fork's call ran (`detailInput`, `detailResult`,
 * `detailPaths`) are read in five places only (the record's own module, the stream's assignment, the observer
 * that sends them, the gate, and the exit-code reader that takes an integer out) and appear in no log call anywhere. A leak guard by name: a new reader has
 * to be added here on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const FIELDS = /\bdetail(?:Input|Result|Paths)\b/;
const ALLOWED = [
	"src/supervisor/providers/claude-stream.ts",
	// AGEN-122: bashExitCodeOf reads `detailResult` and returns only an integer in [0, 255], never text.
	"src/supervisor/providers/claude-turn-rows.ts",
	"src/supervisor/providers/fork-tool-record.ts",
	"src/supervisor/providers/fork-turn-observer.ts",
	"src/supervisor/services/report-gate.ts",
];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const production = ["src", "packages", "bin", "scripts"]
	.flatMap((top) => {
		try {
			return walk(join(ROOT, top));
		} catch {
			return [];
		}
	})
	.map((file) => ({ rel: relative(ROOT, file), source: readFileSync(file, "utf8") }))
	.filter(({ rel }) => !/\.test\.tsx?$/.test(rel) && !rel.includes("/test-utils/"));

describe("detail fields", () => {
	test("they appear only where a call's detail is recorded, sent or judged", () => {
		expect(production.length).toBeGreaterThan(500); // the walk saw the tree
		const touching = production.filter(({ source }) => FIELDS.test(source)).map(({ rel }) => rel);
		expect(touching.filter((rel) => !ALLOWED.includes(rel))).toEqual([]);
		// The record's module and the observer must be among them: a guard that finds nothing proves nothing.
		expect(touching).toContain("src/supervisor/providers/fork-tool-record.ts");
		expect(touching).toContain("src/supervisor/providers/fork-turn-observer.ts");
		expect(touching).toContain("src/supervisor/providers/claude-stream.ts");
	});

	test("they appear in no log call, in any file", () => {
		const offenders: string[] = [];
		const logCall = /(?:\blog|console\.\w+|\.log|logger\.\w+|warn|info)\s*\(([^;]|\n)*?\)\s*;/g;
		for (const { rel, source } of production) {
			for (const match of source.matchAll(logCall)) {
				if (FIELDS.test(match[0])) offenders.push(`${rel}: ${match[0].slice(0, 80)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the log pattern does catch a log call carrying one (the guard is not blind)", () => {
		const logCall = /(?:\blog|console\.\w+|\.log|logger\.\w+|warn|info)\s*\(([^;]|\n)*?\)\s*;/g;
		const bad = "log(`failed: ${call.detailInput}`);";
		expect([...bad.matchAll(logCall)].some((m) => FIELDS.test(m[0]))).toBe(true);
		const fine = "log(`failed: ${call.toolUseId}`);";
		expect([...fine.matchAll(logCall)].some((m) => FIELDS.test(m[0]))).toBe(false);
	});
});
