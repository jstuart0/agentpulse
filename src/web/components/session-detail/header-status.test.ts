/**
 * The session header says the session's state once. The operational badge is
 * the authoritative answer (it already counts the raw isWorking flag), so no
 * second chip may spell a state word next to it. The header is a React
 * component and the harness has no DOM, so this reads its source: if a chip
 * driven by the raw flag comes back, this fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "SessionHeader.tsx"), "utf-8");
// JSX text and string literals, comments removed
const code = source
	.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("SessionHeader says the state once", () => {
	test("exactly one StatusBadge, fed the operational status", () => {
		expect(code.match(/<StatusBadge\b/g)?.length).toBe(1);
		expect(code).toMatch(/<StatusBadge status=\{operationalStatus\}/);
	});

	test("no chip is driven by the raw isWorking flag; the only use is the Activity tab's badge", () => {
		const uses = [...code.matchAll(/isWorking/g)].length;
		expect(uses).toBe(1);
		expect(code).toMatch(/badge=\{session\.isWorking \? "Working" : null\}/);
		// the removed chip: a pulsing dot beside the word "working"
		expect(code).not.toMatch(/animate-pulse-dot[\s\S]{0,80}working/);
	});

	test("no hard-coded state word sits in the header row as JSX text", () => {
		for (const word of ["working", "waiting", "idle"]) {
			expect({ word, found: new RegExp(`>\\s*${word}\\s*<`, "i").test(code) }).toEqual({
				word,
				found: false,
			});
		}
	});
});
