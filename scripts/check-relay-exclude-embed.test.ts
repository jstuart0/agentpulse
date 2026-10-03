/**
 * scripts/relay.ts must stay one self-contained file (the installers embed it
 * as a heredoc), so it cannot import src/shared/exclude-rules.ts. Instead the
 * evaluator's source is copied into it between two marker comments by
 * scripts/embed-exclude-rules.ts, and scripts/check-relay-exclude-embed.ts
 * fails when the block and the source differ. This holds that guard to its
 * word: it passes on the real tree and fails on every kind of drift.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	RELAY_EXCLUDE_BLOCK_END,
	RELAY_EXCLUDE_BLOCK_START,
	buildEmbeddedBlock,
	checkRelayEmbed,
	extractEmbeddedBlock,
	replaceEmbeddedBlock,
} from "./lib/relay-exclude-embed.ts";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

function sources() {
	return {
		relaySource: read("scripts/relay.ts"),
		exclusionSource: read("src/shared/exclude-rules.ts"),
		headersSource: read("src/shared/hook-headers.ts"),
	};
}

describe("the relay's embedded exclude evaluator", () => {
	test("the real tree has no drift", () => {
		expect(checkRelayEmbed(sources())).toEqual([]);
	});

	test("the block is found between exactly one start and one end marker, start first", () => {
		const { relaySource } = sources();
		expect(relaySource.split(RELAY_EXCLUDE_BLOCK_START).length - 1).toBe(1);
		expect(relaySource.split(RELAY_EXCLUDE_BLOCK_END).length - 1).toBe(1);
		expect(relaySource.indexOf(RELAY_EXCLUDE_BLOCK_START)).toBeLessThan(
			relaySource.indexOf(RELAY_EXCLUDE_BLOCK_END),
		);
		expect(extractEmbeddedBlock(relaySource).length).toBeGreaterThan(5000);
	});

	test("a changed character inside the block is drift", () => {
		const s = sources();
		const block = extractEmbeddedBlock(s.relaySource);
		const edited = block.replace(
			"MAX_RULES_FILE_BYTES = 64 * 1024",
			"MAX_RULES_FILE_BYTES = 65 * 1024",
		);
		expect(edited).not.toBe(block);
		const errors = checkRelayEmbed({
			...s,
			relaySource: replaceEmbeddedBlock(s.relaySource, edited),
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join("\n")).toContain("embed:exclude-rules");
	});

	test("an edit to the shared evaluator that was not re-embedded is drift", () => {
		const s = sources();
		const errors = checkRelayEmbed({
			...s,
			exclusionSource: s.exclusionSource.replace(
				'const SKIP_ALLOWLIST = new Set(["1", "true", "yes", "on"]);',
				'const SKIP_ALLOWLIST = new Set(["1", "true", "yes", "on", "y"]);',
			),
		});
		expect(errors.length).toBeGreaterThan(0);
	});

	test("an edit to a header constant the block carries is drift", () => {
		const s = sources();
		const errors = checkRelayEmbed({
			...s,
			headersSource: s.headersSource.replace("EXCLUDE_MAX_RULES = 500", "EXCLUDE_MAX_RULES = 501"),
		});
		expect(errors.length).toBeGreaterThan(0);
	});

	test("a missing marker is reported, not crashed on", () => {
		const s = sources();
		const errors = checkRelayEmbed({
			...s,
			relaySource: s.relaySource.replace(RELAY_EXCLUDE_BLOCK_END, ""),
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join("\n")).toContain("marker");
	});

	test("re-embedding fixes the drift (the embed script's own function is what the guard compares against)", () => {
		const s = sources();
		const drifted = replaceEmbeddedBlock(s.relaySource, "// stale\n");
		expect(checkRelayEmbed({ ...s, relaySource: drifted }).length).toBeGreaterThan(0);
		const fixed = replaceEmbeddedBlock(drifted, buildEmbeddedBlock(s));
		expect(checkRelayEmbed({ ...s, relaySource: fixed })).toEqual([]);
	});

	test("the block holds nothing the installers' embedding forbids, and no import statement", () => {
		const block = buildEmbeddedBlock(sources());
		expect(block).not.toContain("AGENTPULSE_RELAY_TS_EOF");
		expect(block).not.toContain("@@AGENTPULSE_");
		expect(block).not.toMatch(/^\s*import\s/m);
		// every identifier the evaluator exports is carried
		for (const name of [
			"loadExcludeRules",
			"evaluateExclusion",
			"isSkipValue",
			"isSkipHeaderValue",
			"setInvalidMarker",
			"normalizeForCompare",
		]) {
			expect(block).toContain(`function ${name}`);
		}
		for (const name of [
			"EXCLUDE_RULES_RELATIVE_PATH",
			"EXCLUDE_INVALID_MARKER_RELATIVE_PATH",
			"EXCLUDE_MAX_RULES",
			"SKIP_HEADER",
			"SKIP_HEADER_MAX_LENGTH",
		]) {
			expect(block).toContain(`const ${name} =`);
		}
	});
});
