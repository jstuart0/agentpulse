/**
 * The per-ticket canary scenario files (`scripts/claude-canary-scenarios/`) are held to the same safety rules as
 * the canary itself (`claude-canary-scan.test.ts` reads `scripts/` and `scripts/lib/` only): nothing starts Claude
 * but the one spawner and nothing signals a process by name. A scan that read no file would pass, so it first
 * proves it saw them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanClaudeText } from "./lib/claude-canary-safety.js";

const dir = join(import.meta.dir, "claude-canary-scenarios");
const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));

describe("the ticket scenario files", () => {
	test("exist for each ticket, with the helpers and a mutations file beside each", () => {
		for (const ticket of ["t119", "t120", "t121", "t122", "t123"]) {
			expect(files, ticket).toContain(`${ticket}.ts`);
			expect(files, ticket).toContain(`${ticket}-mutations.ts`);
		}
		expect(files).toContain("helpers.ts");
	});

	test("hold the canary's safety rules", () => {
		const findings = files.flatMap((name) =>
			scanClaudeText(
				`scripts/claude-canary-scenarios/${name}`,
				readFileSync(join(dir, name), "utf8"),
			),
		);
		expect(findings).toEqual([]);
	});

	test("a planted kill by name in a ticket file would be flagged (positive control)", () => {
		expect(
			scanClaudeText("scripts/claude-canary-scenarios/t119.ts", 'sh("pkill -f claude");\n').map(
				(f) => f.rule,
			),
		).toContain("kill-by-name");
	});
});
