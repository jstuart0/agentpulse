import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	EXPECTED_SUITES,
	missingSuites,
	orphanSuiteLines,
	runListTokens,
} from "./check-postgres-workflow-suites.js";

const workflow = readFileSync(
	join(import.meta.dir, "..", ".github/workflows/codex-approvals-postgres.yml"),
	"utf8",
);

describe("the Postgres workflow's run lists", () => {
	test("are read: both steps' suites and the folded directory list are tokens (population floor)", () => {
		const tokens = runListTokens(workflow);
		expect(tokens.length).toBeGreaterThanOrEqual(15);
		// A folded `>-` step, a literal `|` step, and a directory prefix.
		for (const member of [
			"src/server/db",
			"src/server/services/session-binding.test.ts",
			"src/server/routes/claude-fork-routes.test.ts",
		]) {
			expect(tokens, member).toContain(member);
		}
	});

	test("the expected list is covered and exists", () => {
		const result = missingSuites(
			workflow,
			EXPECTED_SUITES,
			(p) => Bun.file(join(import.meta.dir, "..", p)).size > 0,
		);
		expect(result).toEqual({ notInWorkflow: [], notOnDisk: [] });
	});

	test("a suite named but absent from the lists fails (positive control), and a listed one passes", () => {
		const exists = () => true;
		expect(
			missingSuites(workflow, ["src/server/services/not-in-the-workflow.test.ts"], exists)
				.notInWorkflow,
		).toEqual(["src/server/services/not-in-the-workflow.test.ts"]);
		expect(
			missingSuites(workflow, ["src/server/routes/claude-fork-routes.test.ts"], exists)
				.notInWorkflow,
		).toEqual([]);
		// A file under a listed directory prefix counts.
		expect(
			missingSuites(workflow, ["src/server/db/some-new.test.ts"], exists).notInWorkflow,
		).toEqual([]);
	});

	test("a suite that is listed but not a file fails", () => {
		expect(
			missingSuites(workflow, ["src/server/routes/claude-fork-routes.test.ts"], () => false)
				.notOnDisk,
		).toEqual(["src/server/routes/claude-fork-routes.test.ts"]);
	});
});

describe("orphan suite lines", () => {
	test("the workflow has none", () => {
		expect(orphanSuiteLines(workflow)).toEqual([]);
	});

	test("the old text (a pipe-to-tee line before a suite line) is caught; a continuation is not", () => {
		const old = [
			"        run: |",
			"          bun test \\",
			"            src/a.test.ts 2>&1 | tee x.log",
			"            src/b.test.ts 2>&1 | tee x.log",
		].join("\n");
		expect(orphanSuiteLines(old)).toEqual(["4: src/b.test.ts 2>&1 | tee x.log"]);
		const fixed = [
			"        run: |",
			"          bun test \\",
			"            src/a.test.ts \\",
			"            src/b.test.ts 2>&1 | tee x.log",
		].join("\n");
		expect(orphanSuiteLines(fixed)).toEqual([]);
	});
});
