import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type SeamFile,
	collectViolationsFromFiles,
	extractTestSeamExports,
	findIdentifierLines,
	isTestOnlyPath,
} from "./lib/test-seam-utils.js";

describe("extractTestSeamExports — synthetic content", () => {
	test("pulls an exported function name ending in ForTest", () => {
		const content = `
export function _setEnqueueHookProcessingOverrideForTest(fn: (() => void) | null): void {
	override = fn;
}
`;
		expect(extractTestSeamExports(content)).toEqual(["_setEnqueueHookProcessingOverrideForTest"]);
	});

	test("pulls an exported async function the same way", () => {
		const content = `
export async function _resetSessionQueuesForTest(): Promise<void> {
	queues.clear();
}
`;
		expect(extractTestSeamExports(content)).toEqual(["_resetSessionQueuesForTest"]);
	});

	test("ignores an exported function that doesn't end in ForTest", () => {
		const content = `
export function createApiKey(name: string): Promise<string> {
	return mint(name);
}
`;
		expect(extractTestSeamExports(content)).toEqual([]);
	});

	test("ignores a non-exported helper even if its name ends in ForTest", () => {
		const content = `
function _helperForTest(): void {}
`;
		expect(extractTestSeamExports(content)).toEqual([]);
	});

	test("de-duplicates when the same name is declared twice (overload-shaped source)", () => {
		const content = `
export function _setXForTest(fn: null): void;
export function _setXForTest(fn: () => void): void;
export function _setXForTest(fn: unknown): void {}
`;
		expect(extractTestSeamExports(content)).toEqual(["_setXForTest"]);
	});
});

describe("extractTestSeamExports — the other ways to declare a seam", () => {
	test("an exported const arrow function", () => {
		expect(extractTestSeamExports("export const _resetXForTest = () => { x = 0; };")).toEqual([
			"_resetXForTest",
		]);
	});

	test("an exported const with a type annotation, and an exported let", () => {
		const content = [
			"export const _clockForTest: (() => number) | null = null;",
			"export let _hookForTest = null;",
		].join("\n");
		expect(extractTestSeamExports(content)).toEqual(["_clockForTest", "_hookForTest"]);
	});

	test("the plural suffix ForTests, as a function and as a const", () => {
		const content = [
			"export function __resetBackendForTests(): void {}",
			"export const __setAdapterForTests = (a: unknown) => a;",
		].join("\n");
		expect(extractTestSeamExports(content)).toEqual([
			"__resetBackendForTests",
			"__setAdapterForTests",
		]);
	});

	test("an export list that renames to a seam name", () => {
		expect(extractTestSeamExports("export { realReset as resetForTest };")).toEqual([
			"resetForTest",
		]);
	});

	test("an export list entry that already ends in ForTest, among ordinary ones, across lines", () => {
		const content = [
			"export {",
			"\tordinary,",
			"\tother as renamed,",
			"\t_seamForTests,",
			"};",
		].join("\n");
		expect(extractTestSeamExports(content)).toEqual(["_seamForTests"]);
	});

	test("an export list with no seam names, and a non-exported const, yield nothing", () => {
		const content = ["const _localForTest = 1;", "export { a, b as c };"].join("\n");
		expect(extractTestSeamExports(content)).toEqual([]);
	});

	test("a re-export of a seam from another module is discovered too", () => {
		expect(extractTestSeamExports('export { _setXForTest } from "./other.js";')).toEqual([
			"_setXForTest",
		]);
	});
});

describe("findIdentifierLines — word-boundary correctness", () => {
	test("finds the line a whole identifier appears on", () => {
		const content = ["const a = 1;", "_setXForTest(null);", "const b = 2;"].join("\n");
		expect(findIdentifierLines(content, "_setXForTest")).toEqual([2]);
	});

	test("does not match a longer identifier that merely contains the name as a substring", () => {
		const content = "const _setXForTestAndMore = 1;";
		expect(findIdentifierLines(content, "_setXForTest")).toEqual([]);
	});

	test("reports every matching line, not just the first", () => {
		const content = ["_setXForTest(a);", "ok();", "_setXForTest(b);"].join("\n");
		expect(findIdentifierLines(content, "_setXForTest")).toEqual([1, 3]);
	});
});

describe("isTestOnlyPath", () => {
	test("a *.test.ts file is test-only", () => {
		expect(isTestOnlyPath("src/server/services/event-processor.test.ts")).toBe(true);
	});

	test("anything under a test-utils/ directory is test-only", () => {
		expect(isTestOnlyPath("src/server/test-utils/db-call-counter.ts")).toBe(true);
	});

	test("an ordinary production file is not test-only", () => {
		expect(isTestOnlyPath("src/server/services/event-processor.ts")).toBe(false);
	});
});

describe("collectViolationsFromFiles — synthetic fixtures", () => {
	function file(rel: string, content: string): SeamFile {
		return { rel, content };
	}

	test("a production file calling another production file's seam is a violation", () => {
		const files = [
			file(
				"src/server/services/event-processor.ts",
				"export function _setPreInsertRaceHookForTest(hook: null): void { hook; }",
			),
			file(
				"src/server/routes/ingest.ts",
				'import { _setPreInsertRaceHookForTest } from "../services/event-processor.js";\n_setPreInsertRaceHookForTest(null);',
			),
		];
		const violations = collectViolationsFromFiles(files);
		expect(violations.length).toBe(2); // the import line and the call line
		expect(violations.every((v) => v.includes("_setPreInsertRaceHookForTest"))).toBe(true);
		expect(violations.every((v) => v.startsWith("src/server/routes/ingest.ts:"))).toBe(true);
	});

	test("the same reference from a *.test.ts file is not a violation", () => {
		const files = [
			file(
				"src/server/services/event-processor.ts",
				"export function _setPreInsertRaceHookForTest(hook: null): void { hook; }",
			),
			file(
				"src/server/services/event-processor.test.ts",
				'import { _setPreInsertRaceHookForTest } from "./event-processor.js";\n_setPreInsertRaceHookForTest(null);',
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("the same reference from a file under test-utils/ is not a violation", () => {
		const files = [
			file(
				"src/server/services/event-processor.ts",
				"export function _setPreInsertRaceHookForTest(hook: null): void { hook; }",
			),
			file(
				"src/server/test-utils/seam-helper.ts",
				'import { _setPreInsertRaceHookForTest } from "../services/event-processor.js";\n_setPreInsertRaceHookForTest(null);',
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("the seam's own defining file is never a violation against itself", () => {
		const files = [
			file(
				"src/server/services/event-processor.ts",
				[
					"export function _setPreInsertRaceHookForTest(hook: null): void {",
					"  _preInsertRaceHookForTest = hook;",
					"}",
					"// internal use elsewhere in the same file is fine too:",
					"if (_setPreInsertRaceHookForTest) {}",
				].join("\n"),
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("no seam exports at all produces no violations", () => {
		const files = [
			file("src/server/services/ordinary.ts", "export function normal() {}"),
			file("src/server/routes/other.ts", 'import { normal } from "../services/ordinary.js";'),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});
});

describe("collectViolationsFromFiles — a seam used by production code in its own file", () => {
	function file(rel: string, content: string): SeamFile {
		return { rel, content };
	}

	test("an ordinary function in the defining file that calls the seam is a violation", () => {
		const files = [
			file(
				"src/server/services/thing.ts",
				[
					"export function _setClockForTest(fn: null): void {",
					"\tclock = fn;",
					"}",
					"",
					"export function doRealWork(): void {",
					"\t_setClockForTest(null);",
					"}",
				].join("\n"),
			),
		];
		const violations = collectViolationsFromFiles(files);
		expect(violations.length).toBe(1);
		expect(violations[0]).toContain("src/server/services/thing.ts:6");
		expect(violations[0]).toContain("_setClockForTest");
	});

	test("one seam calling another, a seam calling itself, comments and strings are fine", () => {
		const files = [
			file(
				"src/server/services/thing.ts",
				[
					"export function _setClockForTest(fn: null): void {",
					"\tclock = fn;",
					"}",
					"export function _resetAllForTest(): void {",
					"\t_setClockForTest(null); // reset the clock too",
					"}",
					"// _setClockForTest is how tests control time",
					'const note = "_setClockForTest";',
					"export function doRealWork(): void {",
					"\t/* never call _setClockForTest here */",
					"}",
				].join("\n"),
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("a production function reading the seam's private variable is not a call to the seam", () => {
		const files = [
			file(
				"src/server/services/thing.ts",
				[
					"let _hookForTest: (() => void) | null = null;",
					"export function _setHookForTest(h: (() => void) | null): void {",
					"\t_hookForTest = h;",
					"}",
					"export function doRealWork(): void {",
					"\t_hookForTest?.();",
					"}",
				].join("\n"),
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("an exported const seam called from a production function in the same file", () => {
		const files = [
			file(
				"src/server/services/thing.ts",
				[
					"export const _tickForTest = () => counter++;",
					"export function handle(): void {",
					"\t_tickForTest();",
					"}",
				].join("\n"),
			),
		];
		const violations = collectViolationsFromFiles(files);
		expect(violations.length).toBe(1);
		expect(violations[0]).toContain("thing.ts:3");
	});
});

describe("collectViolationsFromFiles — production code importing from test-utils", () => {
	function file(rel: string, content: string): SeamFile {
		return { rel, content };
	}

	test("a production file importing a test-utils module is a violation, static or dynamic", () => {
		const files = [
			file(
				"src/server/routes/a.ts",
				'import { reset } from "../test-utils/reset.js";\nconst m = await import("../test-utils/other.js");',
			),
		];
		const violations = collectViolationsFromFiles(files);
		expect(violations.length).toBe(2);
		expect(violations.every((v) => v.includes("test-utils"))).toBe(true);
	});

	test("a test file or another test-utils file importing test-utils is fine", () => {
		const files = [
			file("src/server/routes/a.test.ts", 'import { reset } from "../test-utils/reset.js";'),
			file(
				"src/server/test-utils/b.ts",
				'import { reset } from "./reset.js";\nimport "../test-utils/c.js";',
			),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("a production file importing something that merely has test-utils in a word is fine", () => {
		const files = [
			file("src/server/routes/a.ts", 'import { x } from "../utils/my-test-utils-like.js";'),
		];
		expect(collectViolationsFromFiles(files)).toEqual([]);
	});

	test("a test-utils wrapper that launders a seam is caught at the production import of the wrapper", () => {
		const files = [
			file("src/server/services/thing.ts", "export function _setClockForTest(fn: null): void {}"),
			file(
				"src/server/test-utils/clock.ts",
				'import { _setClockForTest } from "../services/thing.js";\nexport const freeze = () => _setClockForTest(null);',
			),
			file("src/server/routes/handler.ts", 'import { freeze } from "../test-utils/clock.js";'),
		];
		const violations = collectViolationsFromFiles(files);
		expect(violations.length).toBe(1);
		expect(violations[0]).toContain("src/server/routes/handler.ts:1");
	});
});

describe("check-no-test-seam-leaks CLI exit code", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "seam-guard-"));
		roots.push(root);
		for (const [rel, content] of Object.entries(files)) {
			const full = join(root, rel);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
		return root;
	}

	function runGuard(root: string) {
		const script = new URL("./check-no-test-seam-leaks.ts", import.meta.url).pathname;
		const result = Bun.spawnSync([process.execPath, script, "--root", root], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}

	const SEAM = "export function _setClockForTest(fn: null): void {}\n";

	test("a clean tree exits 0 and says so", () => {
		const root = tree({
			"src/server/services/thing.ts": SEAM,
			"src/server/services/thing.test.ts":
				'import { _setClockForTest } from "./thing.js";\n_setClockForTest(null);',
		});
		const { code, stdout } = runGuard(root);
		expect(code).toBe(0);
		expect(stdout).toContain("OK");
	});

	test("a production caller exits 1 and names the file, line and seam", () => {
		const root = tree({
			"src/server/services/thing.ts": SEAM,
			"src/server/routes/handler.ts":
				'import { _setClockForTest } from "../services/thing.js";\n_setClockForTest(null);',
		});
		const { code, stderr } = runGuard(root);
		expect(code).toBe(1);
		expect(stderr).toContain("src/server/routes/handler.ts:2");
		expect(stderr).toContain("_setClockForTest");
	});

	test("a leak in a .tsx file is found", () => {
		const root = tree({
			"src/server/services/thing.ts": SEAM,
			"src/server/routes/view.tsx":
				'import { _setClockForTest } from "../services/thing.js";\nexport const v = () => _setClockForTest(null);',
		});
		const { code, stderr } = runGuard(root);
		expect(code).toBe(1);
		expect(stderr).toContain("view.tsx");
	});

	test("a production import of a test-utils module exits 1", () => {
		const root = tree({
			"src/server/test-utils/helper.ts": "export const helper = 1;\n",
			"src/server/routes/handler.ts":
				'import { helper } from "../test-utils/helper.js";\nexport const h = helper;',
		});
		const { code, stderr } = runGuard(root);
		expect(code).toBe(1);
		expect(stderr).toContain("src/server/routes/handler.ts:1");
	});
});

describe("the real repository has zero test-seam leaks today", () => {
	test("every existing _...ForTest export in src/server is referenced only from tests or test-utils", async () => {
		const { collectTestSeamViolations } = await import("./lib/test-seam-utils.js");
		const root = new URL("..", import.meta.url).pathname;
		const { join } = await import("node:path");
		const violations = await collectTestSeamViolations(root, [join(root, "src", "server")]);
		expect(violations).toEqual([]);
	});
});
