import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The instance mode is compared in exactly one place, ownership-ui.ts. Every
 * other file asks that module what to show, so "solo looks as it always did"
 * is one file to read, not a hunt through the components.
 */
const WEB_ROOT = join(import.meta.dir, "..");
const ALLOWED = new Set(["lib/ownership-ui.ts", "lib/ownership-guard.test.ts"]);
/** The only files that may read the mode out of the user store: the hook that turns it into flags, and the store with its response mapper. */
const MODE_READERS = new Set([
	"hooks/useOwnershipUi.ts",
	"stores/user-store.ts",
	"lib/auth-state.ts",
	"lib/ownership-ui.ts",
	"lib/ownership-guard.test.ts",
]);

const MODE_READ_PATTERNS: RegExp[] = [
	// useUserStore((s) => s.mode), also wrapped over several lines
	/useUserStore\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(?\s*\1\s*\.\s*mode\b/,
	// useUserStore.getState().mode
	/\bgetState\s*\(\s*\)\s*\.\s*mode\b/,
	// const { mode } = useUserStore() / useUserStore.getState()
	/\{[^{}]*\bmode\b[^{}]*\}\s*=\s*(?:useUserStore|[\w.]*getState\s*\(\s*\))/,
	// the whole state, from which the mode can be read in any spelling
	/useUserStore\s*\(\s*\)/,
];

/** Any way of getting the mode out of the user store. With reads confined to one file, no comparison (switch, includes, a constant) can exist elsewhere. */
function findModeReads(source: string): string[] {
	return MODE_READ_PATTERNS.filter((pattern) => pattern.test(source)).map((p) => p.source);
}

const MODE_COMPARISON =
	/(?:===?|!==?)\s*["'](?:team|solo)["']|["'](?:team|solo)["']\s*(?:===?|!==?)/;

function findModeComparisons(source: string): string[] {
	return source.split("\n").filter((line) => MODE_COMPARISON.test(line));
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
	}
	return out;
}

describe("the mode is compared in ownership-ui.ts only", () => {
	test("the scanner sees the forms it is meant to forbid (positive control)", () => {
		expect(findModeComparisons('if (mode === "team") {')).toHaveLength(1);
		expect(findModeComparisons("if (mode !== 'solo') {")).toHaveLength(1);
		expect(findModeComparisons('const x = "team" === mode;')).toHaveLength(1);
		expect(findModeComparisons('switch (mode) { case "team": }')).toHaveLength(0);
		expect(findModeComparisons('const mode: "solo" | "team" = "solo";')).toHaveLength(0);
	});

	test("the read scanner catches the spellings a line regex misses (positive controls)", () => {
		const spellings = [
			'switch (useUserStore((s) => s.mode)) { case "team": return 1; }',
			"const m = useUserStore(\n\t(s) =>\n\t\ts.mode,\n);",
			"const MODE = useUserStore.getState().mode;",
			'const on = ["team"].includes(useUserStore.getState().mode);',
			"const { mode } = useUserStore.getState();",
			"const {\n\teffectiveRole,\n\tmode,\n} = useUserStore();",
			"const all = useUserStore();",
		];
		for (const spelling of spellings) expect(findModeReads(spelling)).not.toEqual([]);
		expect(findModeReads("const role = useUserStore((s) => s.effectiveRole);")).toEqual([]);
		expect(findModeReads("useUserStore.setState({ mode: 'team' });")).toEqual([]);
	});

	test("only the ownership hook and the store itself read the mode from the user store", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(WEB_ROOT)) {
			const rel = relative(WEB_ROOT, file);
			if (MODE_READERS.has(rel)) continue;
			if (findModeReads(readFileSync(file, "utf8")).length > 0) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	test("it scans a real population of files, ownership-ui.ts among them", () => {
		const files = sourceFiles(WEB_ROOT).map((file) => relative(WEB_ROOT, file));
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain("lib/ownership-ui.ts");
	});

	test("no other file under src/web compares the mode", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(WEB_ROOT)) {
			const rel = relative(WEB_ROOT, file);
			if (ALLOWED.has(rel)) continue;
			for (const line of findModeComparisons(readFileSync(file, "utf8"))) {
				offenders.push(`${rel}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
