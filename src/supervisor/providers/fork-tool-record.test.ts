/**
 * AGEN-119..123 Track 0, S1: the typed call record and the detail verdict, decided once from the intact input
 * (F56, C-H3). Nothing here sends anything; the verdict is what AGEN-123 will read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	DETAIL_RESULT_CAP_BYTES,
	type ExcludeScope,
	createDetailJudge,
	createOutputGuard,
	cutDetailResult,
	detailPathsOf,
	expandHomePath,
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
		expect(await judge("Task", { prompt: "x" })).toBe("withhold");
		expect(await judge("", {})).toBe("withhold");
	});

	test("an Agent call is judged like Bash: its prompt against the rules, and a rule beneath the directory withholds", async () => {
		const input = { subagent_type: "general-purpose", description: "d", prompt: "look around" };
		expect(await judgeWith({ state: "none" })("Agent", input)).toBe("send");
		expect(await judgeWith(rulesOver(secret))("Agent", input)).toBe("send");
		expect(
			await judgeWith(rulesOver(secret))("Agent", { ...input, prompt: `read ${secret}/k.txt` }),
		).toBe("withhold");
		expect(await judgeWith(rulesOver(join(work, "vault")))("Agent", input)).toBe("withhold");
		expect(await judgeWith({ state: "invalid" })("Agent", input)).toBe("withhold");
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

// Review M2.
describe("a path tool's home spellings are expanded before they are resolved", () => {
	const home = homedir();
	const marker = `.agentpulse-m2-excluded-${process.pid}`;
	const excluded = join(home, marker);

	test("expandHomePath: ~, ~/x, $HOME/x and ${HOME}/x; ~user is unresolvable; others unchanged", () => {
		expect(expandHomePath("~", "/h")).toBe("/h");
		expect(expandHomePath("~/a/b", "/h")).toBe("/h/a/b");
		expect(expandHomePath("$HOME/a", "/h")).toBe("/h/a");
		expect(expandHomePath("${HOME}/a", "/h")).toBe("/h/a");
		expect(expandHomePath("~other/a", "/h")).toBeNull();
		expect(expandHomePath("/abs/a", "/h")).toBe("/abs/a");
		expect(expandHomePath("rel/a", "/h")).toBe("rel/a");
		expect(expandHomePath("$HOMEWORK/a", "/h")).toBe("$HOMEWORK/a");
	});

	test("a Read of ~/excluded, $HOME/excluded and ${HOME}/excluded is withheld; ~/other is sent (control)", async () => {
		const judge = judgeWith(rulesOver(excluded));
		for (const file_path of [
			`~/${marker}/k.txt`,
			`$HOME/${marker}/k.txt`,
			`$\u007bHOME}/${marker}/k.txt`,
		]) {
			expect(await judge("Read", { file_path }), file_path).toBe("withhold");
		}
		expect(await judge("Read", { file_path: "~/not-excluded/k.txt" })).toBe("send");
		expect(await judge("Write", { file_path: `~/${marker}/new.txt`, content: "x" })).toBe(
			"withhold",
		);
		expect(await judge("Read", { file_path: "~someone/k.txt" })).toBe("withhold");
	});
});

describe("the output guard", () => {
	const call = (name: string, detailResult: string | null) =>
		newToolCallRecord({ toolUseId: "t1", name, detailResult });

	test("a Bash, Agent or MCP result naming a rule path is withheld, in the absolute, relative and ~ forms", () => {
		const home = homedir();
		const rule = join(home, "vault");
		const guard = createOutputGuard({
			cwd: join(home, "proj"),
			excludeScope: () => rulesOver(rule),
		});
		for (const name of ["Bash", "Agent", "mcp__probe__echo"]) {
			expect(guard(call(name, `found ${rule}/key.pem`)), `${name} absolute`).toBe(true);
			expect(guard(call(name, "found ~/vault/key.pem")), `${name} tilde`).toBe(true);
			expect(guard(call(name, "found $HOME/vault/key.pem")), `${name} $HOME`).toBe(true);
			expect(guard(call(name, "found ../vault/key.pem")), `${name} relative`).toBe(true);
		}
	});

	test("an output that names none, no output, no rules and a path tool are all kept (controls)", () => {
		const guard = createOutputGuard({ cwd: work, excludeScope: () => rulesOver(secret) });
		expect(guard(call("Bash", "all good"))).toBe(false);
		expect(guard(call("Bash", null))).toBe(false);
		expect(guard(call("Read", `contents mention ${secret}`))).toBe(false);
		const none = createOutputGuard({ cwd: work, excludeScope: () => ({ state: "none" }) });
		expect(none(call("Bash", `mentions ${secret}`))).toBe(false);
	});

	test("invalid rules withhold any Bash result, and a throwing scope withholds", () => {
		const invalid = createOutputGuard({ cwd: work, excludeScope: () => ({ state: "invalid" }) });
		expect(invalid(call("Bash", "anything"))).toBe(true);
		const broken = createOutputGuard({
			cwd: work,
			excludeScope: () => {
				throw new Error("boom");
			},
		});
		expect(broken(call("Bash", "anything"))).toBe(true);
	});
});
