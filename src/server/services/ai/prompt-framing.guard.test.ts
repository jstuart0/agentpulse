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
 *   (c) finds every model call site, literal request or not, and requires a
 *       named framing test for it: the table's keys equal the found sites.
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

/** Every model call site and the test file with its `framing: <site>` title. */
const FRAMING_TESTS: Record<string, string> = {
	"src/server/services/ai/alert-rule-evaluator.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ai/notify/watcher-notify.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ai/runner.ts": "src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ai/semantic-enricher.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ask/ask-qa-handler.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ask/ask-service.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/ask/launch-intent-detector.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
	"src/server/services/session-summary-service.ts":
		"src/server/services/ai/managed-content-untrusted.test.ts",
};

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

/** The sites the table lacks, and table entries whose test title is missing from the file. */
async function coverageProblems(
	found: readonly string[],
	table: Record<string, string>,
	read: (rel: string) => Promise<string>,
): Promise<string[]> {
	const problems: string[] = [];
	for (const site of found) if (!table[site]) problems.push(`no framing test for ${site}`);
	for (const [site, testFile] of Object.entries(table)) {
		if (!found.includes(site)) problems.push(`table entry ${site} is not a model call site`);
		const source = await read(testFile).catch(() => null);
		if (source === null) problems.push(`${testFile} does not exist`);
		else if (!source.includes(`framing: ${site}`))
			problems.push(`${testFile} has no test titled "framing: ${site}"`);
	}
	return problems;
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

	test("(c) every model call site has a framing test, and no entry is stale", async () => {
		const found = await modelCallSites();
		// A population floor: an emptied search must not pass. Named member: the watcher.
		expect(found.length).toBeGreaterThanOrEqual(8);
		expect(found).toContain("src/server/services/ai/runner.ts");
		expect(Object.keys(FRAMING_TESTS).sort()).toEqual(found);
		expect(await coverageProblems(found, FRAMING_TESTS, readRepoFile)).toEqual([]);
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

	test("planted negative: a site missing from the table is reported", async () => {
		const problems = await coverageProblems(
			["src/server/services/ai/new-site.ts"],
			{},
			async () => "",
		);
		expect(problems).toEqual(["no framing test for src/server/services/ai/new-site.ts"]);
	});

	test("planted negative: a table entry whose test title is absent is reported", async () => {
		const site = "src/server/services/ai/new-site.ts";
		const problems = await coverageProblems(
			[site],
			{ [site]: "some.test.ts" },
			async () => "no title",
		);
		expect(problems).toEqual([`some.test.ts has no test titled "framing: ${site}"`]);
	});

	test("planted negative: a table entry that is not a call site is reported", async () => {
		const problems = await coverageProblems(
			[],
			{ "gone.ts": "t.test.ts" },
			async () => "framing: gone.ts",
		);
		expect(problems).toEqual(["table entry gone.ts is not a model call site"]);
	});
});
