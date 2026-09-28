import { describe, expect, test } from "bun:test";
/**
 * enums.test.ts — D5 observed/launchable enum split (2026-09-28-deliver-agent-cli-parity).
 *
 * Phase 1 keeps OBSERVED_AGENT_TYPE_ENUM and LAUNCHABLE_AGENT_TYPE_ENUM
 * value-identical (D5's honest note); this test's four call-site
 * assertions are therefore a scaffold that Phase 6 fills in with a value
 * ("copilot_cli") that actually discriminates between them. They're still
 * written now so the scaffold and Phase 6's discriminating run are
 * provably the same test, not a parallel one that could drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHABLE_AGENT_TYPE_ENUM, OBSERVED_AGENT_TYPE_ENUM } from "./enums.js";

describe("OBSERVED_AGENT_TYPE_ENUM / LAUNCHABLE_AGENT_TYPE_ENUM", () => {
	test("both parse claude_code and codex_cli", () => {
		for (const value of ["claude_code", "codex_cli"] as const) {
			expect(OBSERVED_AGENT_TYPE_ENUM.parse(value)).toBe(value);
			expect(LAUNCHABLE_AGENT_TYPE_ENUM.parse(value)).toBe(value);
		}
	});

	test("both reject a bogus value", () => {
		expect(() => OBSERVED_AGENT_TYPE_ENUM.parse("bogus")).toThrow();
		expect(() => LAUNCHABLE_AGENT_TYPE_ENUM.parse("bogus")).toThrow();
	});
});

// Source-level check that each of the four call sites imports the enum it's
// *supposed* to use (D5: sessions.ts is observed; templates/orchestrate/
// catalog are launchable). Package-relative reads, not a live tool-schema
// introspection — see file header.
const SRC_ROOT = new URL(".", import.meta.url).pathname;
function readSource(relPath: string): string {
	return readFileSync(join(SRC_ROOT, relPath), "utf8");
}

describe("four call-site assertions (F12 scaffold)", () => {
	test("tools/sessions.ts's list_sessions schema uses the observed enum", () => {
		const src = readSource("tools/sessions.ts");
		expect(src).toContain("OBSERVED_AGENT_TYPE_ENUM");
		expect(src).not.toMatch(/agent_type:\s*LAUNCHABLE_AGENT_TYPE_ENUM/);
	});

	test("tools/templates.ts's create/update schema uses the launchable enum", () => {
		const src = readSource("tools/templates.ts");
		expect(src).toContain("LAUNCHABLE_AGENT_TYPE_ENUM");
		expect(src).not.toMatch(/agent_type:\s*OBSERVED_AGENT_TYPE_ENUM/);
	});

	test("tools/orchestrate.ts's launch tool schema(s) use the launchable enum", () => {
		const src = readSource("tools/orchestrate.ts");
		expect(src).toContain("LAUNCHABLE_AGENT_TYPE_ENUM");
		expect(src).not.toMatch(/agentType:\s*OBSERVED_AGENT_TYPE_ENUM/);
	});

	test("tools/catalog.ts's list_templates schema uses the launchable enum", () => {
		const src = readSource("tools/catalog.ts");
		expect(src).toContain("LAUNCHABLE_AGENT_TYPE_ENUM");
		expect(src).not.toMatch(/agent_type:\s*OBSERVED_AGENT_TYPE_ENUM/);
	});
});
