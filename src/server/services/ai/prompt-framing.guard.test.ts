/**
 * AGEN-22 structural guard: event text in a model prompt is fenced by
 * `fenceUntrusted` / `fenceUntrustedLines`, and every model call site has a
 * framing test.
 *
 * It does three things:
 *   (a) bans a hand-built delimiter, a template like `<tag-${nonce}>`, where
 *       prompts are built (only `untrusted-text.ts` may build one);
 *   (b) bans a stray `randomUUID` there: the files that mention it are a named
 *       set, each with its reason, so a second nonce scheme cannot appear quietly;
 *   (c) finds every model call, literal request or not, and requires a named framing
 *       test for each one: a file's number of calls equals its number of table
 *       entries, and each entry's title is the title of a describe(/test( in the
 *       test file (a comment or a string that merely mentions it doesn't count).
 *
 * What it cannot catch: a call through an alias (`const f = adapter.complete;
 * f(x)`), a new adapter method under another name, a delimiter built by
 * concatenation or from a non-UUID random value, and session text that a
 * behavioural test doesn't seed. It reads source; it does not follow data.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, modelCallSites, productionFiles } from "../../test-utils/llm-call-sites.js";

/** Where prompts are built. */
const PROMPT_SCOPE = [
	"src/server/services/ai/",
	"src/server/services/ask/",
	"src/server/services/session-summary-service.ts",
];
const DELIMITER_BUILDER = "src/server/services/ai/untrusted-text.ts";

/** Files in the scope that may mention `randomUUID`, and why. */
const RANDOM_UUID_REASONS: Record<string, string> = {
	[DELIMITER_BUILDER]: "the fence nonce",
	"src/server/services/ai/proposal-resolution.ts": "a control action id",
	"src/server/services/ai/hitl-decision-service.ts": "a row id",
	"src/server/services/session-summary-service.ts": "the generation lease token",
};

/** The test file every framing test lives in. */
const FRAMING_FILE = "src/server/services/ai/managed-content-untrusted.test.ts";

/**
 * Every model call, by file, with the title of the framing test for each call, in source order.
 * A file with one call has one title, `framing: <file>`; a file with several names each call.
 */
const FRAMING_CALLS: Record<string, string[]> = {
	"src/server/services/ai/alert-rule-evaluator.ts": [],
	"src/server/services/ai/notify/watcher-notify.ts": [],
	"src/server/services/ai/runner.ts": ["decision call", "schema retry call"],
	"src/server/services/ai/semantic-enricher.ts": [],
	"src/server/services/ask/ask-qa-handler.ts": [],
	"src/server/services/ask/ask-service.ts": ["sync", "stream"],
	"src/server/services/ask/launch-intent-detector.ts": [],
	"src/server/services/session-summary-service.ts": [],
};

/** A file's call labels as full test titles: no label means the file's single call. */
const titlesOf = (site: string, labels: readonly string[]): string[] =>
	labels.length === 0
		? [`framing: ${site}`]
		: labels.map((label) => `framing: ${site} :: ${label}`);

const HAND_BUILT_DELIMITER = /`<\/?[a-z][a-z-]*-\$\{/;
const RANDOM_UUID = /randomUUID/;

const inScope = (rel: string) =>
	PROMPT_SCOPE.some((p) => rel.startsWith(p)) &&
	!rel.includes("/__fixtures__/") &&
	!/\.fixture\.ts$/.test(rel);

/** Files in `files` whose source matches `re`. */
function filesMatching(files: Array<{ rel: string; source: string }>, re: RegExp): string[] {
	return files
		.filter((f) => re.test(f.source))
		.map((f) => f.rel)
		.sort();
}

async function scopedFiles() {
	const out: Array<{ rel: string; source: string }> = [];
	for await (const file of productionFiles()) if (inScope(file.rel)) out.push(file);
	return out;
}

const MODEL_CALL =
	/\.complete\(|\.completeStream\(|\[\s*["'`]complete(?:Stream)?["'`]\s*\]|\bstreamWithFallback\(/g;

/** How many model calls `source` makes. */
const callCount = (source: string): number => (source.match(MODEL_CALL) ?? []).length;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `testSource` has a describe/test whose title starts with `title`. */
const hasTitled = (testSource: string, title: string): boolean =>
	new RegExp(`\\b(?:describe|test|it)\\w*(?:\\.\\w+)?\\(\\s*["'\`]${escapeRe(title)}`).test(
		testSource,
	);

/**
 * What is missing: a file whose number of calls differs from its number of table entries,
 * a table entry for a file that makes no call, and a title that is not a describe/test title.
 */
async function coverageProblems(
	calls: ReadonlyMap<string, number>,
	table: Record<string, string[]>,
	read: (rel: string) => Promise<string>,
	testFile: string,
): Promise<string[]> {
	const problems: string[] = [];
	for (const [site, count] of calls) {
		const entries = titlesOf(site, table[site] ?? []);
		if (!table[site]) problems.push(`no framing test for ${site}`);
		else if (entries.length !== count)
			problems.push(`${site} makes ${count} model calls but the table has ${entries.length}`);
	}
	for (const site of Object.keys(table))
		if (!calls.has(site)) problems.push(`table entry ${site} is not a model call site`);
	const testSource = await read(testFile).catch(() => null);
	if (testSource === null) return [...problems, `${testFile} does not exist`];
	for (const [site, labels] of Object.entries(table))
		for (const title of titlesOf(site, labels))
			if (!hasTitled(testSource, title)) problems.push(`${testFile} has no test titled "${title}"`);
	return problems;
}

async function modelCalls(): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for await (const { rel, source } of productionFiles()) {
		const count = callCount(source);
		if (count > 0) out.set(rel, count);
	}
	return out;
}

const readRepoFile = (rel: string) => readFile(join(ROOT, rel), "utf8");

describe("prompt framing guard", () => {
	test("(a) no file but untrusted-text.ts builds a delimiter by hand", async () => {
		const offenders = filesMatching(await scopedFiles(), HAND_BUILT_DELIMITER).filter(
			(rel) => rel !== DELIMITER_BUILDER,
		);
		expect(offenders).toEqual([]);
	});

	test("(b) the files that mention randomUUID are the named set", async () => {
		const files = await scopedFiles();
		expect(filesMatching(files, RANDOM_UUID)).toEqual(Object.keys(RANDOM_UUID_REASONS).sort());
		for (const [file, reason] of Object.entries(RANDOM_UUID_REASONS)) {
			expect(reason.length, file).toBeGreaterThan(0);
		}
	});

	test("(c) every model call has a framing test, and no entry is stale", async () => {
		const found = await modelCallSites();
		// A population floor: an emptied search must not pass. Named member: the watcher.
		expect(found.length).toBeGreaterThanOrEqual(8);
		expect(found).toContain("src/server/services/ai/runner.ts");
		const calls = await modelCalls();
		expect([...calls.keys()].sort()).toEqual(found);
		expect(calls.get("src/server/services/ai/runner.ts")).toBe(2);
		expect(Object.keys(FRAMING_CALLS).sort()).toEqual(found);
		expect(await coverageProblems(calls, FRAMING_CALLS, readRepoFile, FRAMING_FILE)).toEqual([]);
	});

	test("the scope reaches the files that build prompts", async () => {
		const files = (await scopedFiles()).map((f) => f.rel);
		for (const named of [
			DELIMITER_BUILDER,
			"src/server/services/ai/context.ts",
			"src/server/services/ask/context-builder.ts",
			"src/server/services/session-summary-service.ts",
		]) {
			expect(files).toContain(named);
		}
	});

	test("planted negative: a hand-built tag is caught", () => {
		const planted = [
			{ rel: "src/server/services/ai/x.ts", source: "const open = `<transcript-${nonce}>`;" },
		];
		expect(filesMatching(planted, HAND_BUILT_DELIMITER)).toEqual(["src/server/services/ai/x.ts"]);
		const closing = [{ rel: "a.ts", source: "return `</sessions-${n}>`;" }];
		expect(filesMatching(closing, HAND_BUILT_DELIMITER)).toEqual(["a.ts"]);
		const harmless = [{ rel: "b.ts", source: "const doc = `The block is <sessions-…> tagged`;" }];
		expect(filesMatching(harmless, HAND_BUILT_DELIMITER)).toEqual([]);
	});

	test("planted negative: a stray randomUUID is caught", () => {
		const planted = [
			{ rel: "src/server/services/ai/y.ts", source: "const n = crypto.randomUUID();" },
		];
		expect(filesMatching(planted, RANDOM_UUID)).toEqual(["src/server/services/ai/y.ts"]);
	});

	const planted = "src/server/services/ai/new-site.ts";
	const plantedTests = (...titles: string[]) =>
		titles.map((t) => `describe("${t}", () => {});`).join("\n");

	test("planted negative: a site missing from the table is reported", async () => {
		const problems = await coverageProblems(new Map([[planted, 1]]), {}, async () => "", "t.ts");
		expect(problems).toContain(`no framing test for ${planted}`);
	});

	test("planted negative: a second unframed call in an already-covered file is reported", async () => {
		const runner = "src/server/services/ai/runner.ts";
		const source = plantedTests(
			`framing: ${runner} :: decision call`,
			`framing: ${runner} :: schema retry call`,
		);
		const table = { [runner]: ["decision call", "schema retry call"] };
		expect(
			await coverageProblems(new Map([[runner, 2]]), table, async () => source, "t.ts"),
		).toEqual([]);
		const problems = await coverageProblems(
			new Map([[runner, 3]]),
			table,
			async () => source,
			"t.ts",
		);
		expect(problems).toEqual([`${runner} makes 3 model calls but the table has 2`]);
	});

	test("planted negative: a title that is only in a comment or a string is reported", async () => {
		const source = `// framing: ${planted}\nconst x = "framing: ${planted}";`;
		const problems = await coverageProblems(
			new Map([[planted, 1]]),
			{ [planted]: [] },
			async () => source,
			"t.ts",
		);
		expect(problems).toEqual([`t.ts has no test titled "framing: ${planted}"`]);
	});

	test("a title inside describe, describeSqliteOnly and test counts", async () => {
		for (const opener of ["describe", "describeSqliteOnly", "test", "describe.skip"]) {
			const source = `${opener}("framing: ${planted}", () => {});`;
			expect(
				await coverageProblems(
					new Map([[planted, 1]]),
					{ [planted]: [] },
					async () => source,
					"t.ts",
				),
			).toEqual([]);
		}
	});

	test("planted negative: a table entry that is not a call site is reported", async () => {
		const problems = await coverageProblems(
			new Map(),
			{ "gone.ts": [] },
			async () => plantedTests("framing: gone.ts"),
			"t.ts",
		);
		expect(problems).toEqual(["table entry gone.ts is not a model call site"]);
	});

	test("callCount counts each model call, literal request or not", () => {
		expect(
			callCount("a.complete({}); b.completeStream(x); streamWithFallback(a, b); c['complete'](y)"),
		).toBe(4);
		expect(callCount("const f = 1;")).toBe(0);
	});
});
