/**
 * AGEN-21 (security, Medium): main() must call ensureSupervisorConfigPrivate
 * — the startup self-heal that tightens a pre-fix, over-permissive
 * supervisor.json to 0600 — before anything reads the file via
 * loadSupervisorConfig(). Behavioral coverage for
 * ensureSupervisorConfigPrivate itself lives in config.test.ts; main() also
 * performs real network registration against config.serverUrl, which isn't
 * worth mocking just to prove call order, so this is a static ordering
 * check on the real source (never a reimplementation of main()).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

function extractMainBody(source: string): string {
	const start = source.indexOf("async function main()");
	if (start === -1) throw new Error("async function main() not found in src/supervisor/index.ts");
	return source.slice(start);
}

describe("src/supervisor/index.ts main() startup order (AGEN-21)", () => {
	test("imports ensureSupervisorConfigPrivate from ./config.js", () => {
		expect(SOURCE).toMatch(
			/import\s*\{[^}]*\bensureSupervisorConfigPrivate\b[^}]*\}\s*from\s*"\.\/config\.js"/,
		);
	});

	test("main() calls ensureSupervisorConfigPrivate() before loadSupervisorConfig()", () => {
		const body = extractMainBody(SOURCE);
		const tightenIndex = body.indexOf("ensureSupervisorConfigPrivate()");
		const loadIndex = body.indexOf("loadSupervisorConfig()");
		expect(tightenIndex).toBeGreaterThan(-1);
		expect(loadIndex).toBeGreaterThan(-1);
		expect(tightenIndex).toBeLessThan(loadIndex);
	});
});
