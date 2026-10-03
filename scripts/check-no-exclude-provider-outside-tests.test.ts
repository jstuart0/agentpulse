/**
 * The guard that keeps test-injection arguments out of production call sites
 * counts a call's arguments by walking its parentheses. These pin the shapes
 * that walk once got wrong: the formatter's own multi-line call with a
 * trailing comma (counted one too many) and a call whose arguments are all
 * literals (counted as none).
 */
import { describe, expect, test } from "bun:test";
import { countCallArguments, findCallOffences } from "./check-no-exclude-provider-outside-tests.ts";

/** The argument count of the first call to `f` in `source`. */
function count(source: string): number {
	return countCallArguments(source, source.indexOf("(", source.indexOf("f")));
}

describe("counting a call's arguments", () => {
	test("the formatter's multi-line call with a trailing comma has the arguments it shows", () => {
		expect(count("f(\n\tstatePath,\n\tcontent,\n);")).toBe(2);
		expect(count("f(\n\tstatePath,\n);")).toBe(1);
		expect(count("f(a, b,);")).toBe(2);
		expect(count("f(a,\n);")).toBe(1);
	});

	test("an argument list of literals only is counted, not read as empty", () => {
		expect(count('f("x");')).toBe(1);
		expect(count('f("x", "y");')).toBe(2);
		expect(count("f('x', `y ${z}`);")).toBe(2);
		expect(count("f(1, 2, 3);")).toBe(3);
		expect(count('f("");')).toBe(1);
	});

	test("a call with no arguments is none, and nesting does not leak commas into the count", () => {
		expect(count("f();")).toBe(0);
		expect(count("f({});")).toBe(1);
		expect(count("f([]);")).toBe(1);
		expect(count("f(g());")).toBe(1);
		expect(count("f({}, []);")).toBe(2);
		expect(count("f( );")).toBe(0);
		expect(count("f({ a: 1, b: [1, 2, 3] }, g(1, 2));")).toBe(2);
		expect(count("f(\n\t{ a: 1, b: 2, },\n\t[1, 2,],\n);")).toBe(2);
	});

	test("commas, quotes and parentheses inside strings and comments are not arguments", () => {
		expect(count('f("a, b", "c (d");')).toBe(2);
		expect(count("f(a, // one, two\n\tb);")).toBe(2);
		expect(count("f(a, /* it's, here */ b);")).toBe(2);
		expect(count("f(a /* ) */, b);")).toBe(2);
	});
});

describe("finding calls over their ceiling", () => {
	test("the formatter's own two-argument call of writePrivateFileAtomicNoFollow (ceiling two) is not reported", () => {
		const source =
			"writePrivateFileAtomicNoFollow(\n\tstatePath,\n\t`${JSON.stringify(x)}\\n`,\n);";
		expect(findCallOffences("src/x.ts", source)).toEqual([]);
	});

	test("a third argument is reported, with or without a trailing comma", () => {
		const plain = "writePrivateFileAtomicNoFollow(path, content, rename);";
		const formatted = "writePrivateFileAtomicNoFollow(\n\tpath,\n\tcontent,\n\trename,\n);";
		for (const source of [plain, formatted]) {
			expect(findCallOffences("src/x.ts", source)).toEqual([
				"src/x.ts:1: writePrivateFileAtomicNoFollow() called with 3 arguments (max 2 outside a test file)",
			]);
		}
	});

	test("a provider passed as a literal is reported (this once counted as no arguments)", () => {
		expect(findCallOffences("src/x.ts", 'loadExcludeRules("a", "b");')).toEqual([
			"src/x.ts:1: loadExcludeRules() called with 2 arguments (max 1 outside a test file)",
		]);
		expect(findCallOffences("src/x.ts", "loadExcludeRules(home, null);")).toHaveLength(1);
		expect(findCallOffences("src/x.ts", "loadExcludeRules(home);")).toEqual([]);
		expect(findCallOffences("src/x.ts", "loadExcludeRules(home,);")).toEqual([]);
	});

	test("a function declaration of the same name is not a call", () => {
		expect(findCallOffences("src/x.ts", "function loadExcludeRules(home, fs = real) {}")).toEqual(
			[],
		);
	});
});
