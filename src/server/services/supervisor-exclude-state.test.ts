/**
 * What a host's exclude-file state looks like to everything that reads it: the
 * server's shared type, the MCP package's vendored copy of it, and the two
 * documents that describe it all say the same thing, and it is only "invalid"
 * (or null when there is nothing to act on).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf-8");
const FIELD = /^\s*excludeRulesState\?:.*$/m;

describe("the exclude-file state a host carries is only ever invalid or null", () => {
	test("the shared type and the MCP package's vendored type declare exactly the same field, and it is invalid | null", () => {
		const shared = FIELD.exec(read("src/shared/types.ts"))?.[0].trim();
		const vendored = FIELD.exec(read("packages/agentpulse-mcp/src/types.ts"))?.[0].trim();
		expect(shared).toBe('excludeRulesState?: "invalid" | null;');
		expect(vendored).toBe(shared);
	});

	test("the MCP documents name only invalid, not the states the server no longer keeps", () => {
		for (const file of ["docs/MCP.md", "packages/agentpulse-mcp/README.md"]) {
			const line = read(file)
				.split("\n")
				.find((l) => l.includes("excludeRulesState"));
			expect(line, file).toBeDefined();
			expect(line, file).toContain('"invalid"');
			expect(line, file).not.toContain('"none"');
			expect(line, file).not.toContain('"ok"');
		}
	});
});
