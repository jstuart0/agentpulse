/**
 * AGEN-119..123 Track 0, S1: the typed call record and the detail verdict, decided once from the intact input
 * (F56, C-H3). Nothing here sends anything; the verdict is what AGEN-123 will read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DETAIL_RESULT_CAP_BYTES,
	type ExcludeScope,
	createDetailJudge,
	cutDetailResult,
	detailPathsOf,
	newToolCallRecord,
} from "./fork-tool-record.js";

let root: string;
let work: string;
let secret: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "detail-verdict-")));
	work = join(root, "work");
	secret = join(root, "excluded");
	mkdirSync(work, { recursive: true });
	mkdirSync(secret, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A gate's view of rules: the paths given, `invalid`, or none. */
function judgeWith(scope: ExcludeScope, cwd = work) {
	const covers = (path: string) =>
		scope.state === "invalid" ||
		(scope.state === "ok" && scope.paths.some((p) => path === p || path.startsWith(`${p}/`)));
	return createDetailJudge({ cwd, excludesPath: covers, excludeScope: () => scope });
}
const RULES: ExcludeScope = { state: "ok", paths: [] };
const rulesOver = (...paths: string[]): ExcludeScope => ({ state: "ok", paths });

describe("the record", () => {
	test("a new record is withheld until a verdict is in, and carries the detail fields empty", () => {
		const record = newToolCallRecord({ toolUseId: "t", name: "Bash" });
		expect(record).toMatchObject({
			detailVerdict: "withhold",
			detailInput: undefined,
			detailResult: null,
			detailResultBytes: 0,
			agentId: null,
			parentToolUseId: null,
			detailPaths: {},
		});
	});

	test("typed paths: strings come through, a non-string path is null, other tools have none", () => {
		expect(detailPathsOf({ file_path: "/a", content: "x" })).toEqual({ filePath: "/a" });
		expect(detailPathsOf({ notebook_path: "/n.ipynb" })).toEqual({ notebookPath: "/n.ipynb" });
		expect(detailPathsOf({ command: "ls" })).toEqual({});
		expect(detailPathsOf({ file_path: 7 })).toBeNull();
		expect(detailPathsOf({ notebook_path: { a: 1 } })).toBeNull();
		expect(detailPathsOf("not an object")).toEqual({});
	});

	test("the result is cut at the transport cap on a code point, with its real size kept", () => {
		const small = cutDetailResult("Exit code 3\noops");
		expect(small).toEqual({ text: "Exit code 3\noops", bytes: 16 });
		expect(cutDetailResult(null)).toEqual({ text: null, bytes: 0 });
		const big = cutDetailResult("é".repeat(DETAIL_RESULT_CAP_BYTES)); // 2 bytes each
		expect(big.bytes).toBe(DETAIL_RESULT_CAP_BYTES * 2);
		expect(new TextEncoder().encode(big.text ?? "").length).toBeLessThanOrEqual(
			DETAIL_RESULT_CAP_BYTES,
		);
		expect(big.text).not.toContain("�");
		// Four-byte characters: the cut never lands inside one.
		const emoji = cutDetailResult("😀".repeat(DETAIL_RESULT_CAP_BYTES));
		expect(emoji.text).not.toContain("�");
		expect(emoji.bytes).toBe(DETAIL_RESULT_CAP_BYTES * 4);
	});
});

describe("the verdict for tools with a typed path", () => {
	test("a file in the working directory is sent; a new file in it is too", async () => {
		const judge = judgeWith(rulesOver(secret));
		expect(await judge("Read", { file_path: join(work, "a.txt") })).toBe("send");
		expect(
			await judge("Write", { file_path: join(work, "new", "deep", "b.txt"), content: "x" }),
		).toBe("send");
		expect(
			await judge("Edit", { file_path: join(work, "a.txt"), old_string: "a", new_string: "b" }),
		).toBe("send");
		expect(await judge("NotebookEdit", { notebook_path: join(work, "n.ipynb") })).toBe("send");
	});

	test("an excluded path is withheld, and so is a symlink into one", async () => {
		const judge = judgeWith(rulesOver(secret));
		expect(await judge("Read", { file_path: join(secret, "k.txt") })).toBe("withhold");
		symlinkSync(secret, join(work, "link"));
		expect(await judge("Read", { file_path: join(work, "link", "k.txt") })).toBe("withhold");
		expect(await judge("Write", { file_path: join(work, "link", "new.txt"), content: "x" })).toBe(
			"withhold",
		);
	});

	test("an unparseable path, a non-string, a non-object input and invalid rules are all withheld", async () => {
		const judge = judgeWith(RULES);
		expect(await judge("Read", { file_path: 5 })).toBe("withhold");
		expect(await judge("Read", { file_path: "" })).toBe("withhold");
		expect(await judge("Read", {})).toBe("withhold");
		expect(await judge("Read", "a string")).toBe("withhold");
		expect(await judge("Read", null)).toBe("withhold");
		expect(await judgeWith({ state: "invalid" })("Read", { file_path: join(work, "a") })).toBe(
			"withhold",
		);
	});

	test("a relative path is judged against the working directory", async () => {
		const judge = judgeWith(rulesOver(join(work, "private")));
		expect(await judge("Read", { file_path: "private/x" })).toBe("withhold");
		expect(await judge("Read", { file_path: "public/x" })).toBe("send");
	});

	test("a Write whose 200 KiB input names an excluded path after byte 16 KiB is still withheld (the verdict reads the intact input)", async () => {
		const input = { content: "x".repeat(200 * 1024), file_path: join(secret, "k.txt") };
		expect(JSON.stringify(input).indexOf("file_path")).toBeGreaterThan(16 * 1024);
		expect(await judgeWith(rulesOver(secret))("Write", input)).toBe("withhold");
	});
});

describe("the verdict for Bash and MCP", () => {
	test("no rules: sent", async () => {
		expect(await judgeWith({ state: "none" })("Bash", { command: "ls" })).toBe("send");
		expect(await judgeWith({ state: "none" })("mcp__s__t", { a: 1 })).toBe("send");
	});

	test("a rule beneath the working directory withholds every command", async () => {
		const judge = judgeWith(rulesOver(join(work, "vault")));
		expect(await judge("Bash", { command: "echo hello" })).toBe("withhold");
		expect(await judge("mcp__s__t", { q: "hello" })).toBe("withhold");
	});

	test("a rule equal to the working directory withholds too", async () => {
		expect(await judgeWith(rulesOver(work))("Bash", { command: "ls" })).toBe("withhold");
	});

	test("a command naming a rule's path anywhere in 100 KiB is withheld, and one that does not is sent", async () => {
		const judge = judgeWith(rulesOver(secret));
		const long = `${"echo a; ".repeat(15_000)}cat ${secret}/k.txt`;
		expect(long.length).toBeGreaterThan(100 * 1024);
		expect(await judge("Bash", { command: long })).toBe("withhold");
		expect(await judge("Bash", { command: "echo a; ".repeat(15_000) })).toBe("send");
		expect(await judge("mcp__s__t", { path: `${secret}/k` })).toBe("withhold");
	});

	test("WebFetch has no path; any other tool name is withheld", async () => {
		const judge = judgeWith(rulesOver(secret));
		expect(await judge("WebFetch", { url: "https://example.com", prompt: "p" })).toBe("send");
		expect(await judge("Agent", { prompt: "x" })).toBe("withhold");
		expect(await judge("", {})).toBe("withhold");
	});

	test("a Bash input that is not an object, or whose command is not text, is withheld", async () => {
		const judge = judgeWith(rulesOver(secret));
		expect(await judge("Bash", { command: 5 })).toBe("withhold");
		expect(await judge("Bash", [1])).toBe("withhold");
	});

	test("a throwing resolver is a withhold, never a throw", async () => {
		const judge = createDetailJudge({
			cwd: work,
			excludesPath: () => false,
			excludeScope: () => {
				throw new Error("boom");
			},
		});
		expect(await judge("Bash", { command: "ls" })).toBe("withhold");
	});
});
