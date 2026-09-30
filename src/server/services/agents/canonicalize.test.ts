import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HookEventPayload } from "../../../shared/types.js";
import { HOOK_PAYLOAD_CANONICALIZERS, canonicalizeHookPayload } from "./canonicalize.js";

describe("HOOK_PAYLOAD_CANONICALIZERS — Phase 1 seam (identity for existing agents)", () => {
	test("claude_code returns the identical object reference", () => {
		const input = { session_id: "s1", hook_event_name: "SessionStart" } as HookEventPayload;
		const out = HOOK_PAYLOAD_CANONICALIZERS.claude_code(input);
		expect(Object.is(out, input)).toBe(true);
	});

	test("codex_cli returns the identical object reference", () => {
		const input = { session_id: "s1", hook_event_name: "SessionStart" } as HookEventPayload;
		const out = HOOK_PAYLOAD_CANONICALIZERS.codex_cli(input);
		expect(Object.is(out, input)).toBe(true);
	});
});

describe("canonicalizeHookPayload", () => {
	test("dispatches to the registered canonicalizer and passes the hint through", () => {
		const input = { session_id: "s1", hook_event_name: "SessionStart" } as HookEventPayload;
		const out = canonicalizeHookPayload("claude_code", input, "SessionStart");
		expect(Object.is(out, input)).toBe(true);
	});

	test("never throws — a canonicalizer error falls back to the raw body", () => {
		const input = { session_id: "s1", hook_event_name: "SessionStart" } as HookEventPayload;
		const throwing = () => {
			throw new Error("boom");
		};
		const original = HOOK_PAYLOAD_CANONICALIZERS.claude_code;
		// biome-ignore lint/suspicious/noExplicitAny: swapping in a throwing canonicalizer for one call to prove the try/catch fallback
		(HOOK_PAYLOAD_CANONICALIZERS as any).claude_code = throwing;
		try {
			const out = canonicalizeHookPayload("claude_code", input);
			expect(out).toBe(input);
		} finally {
			HOOK_PAYLOAD_CANONICALIZERS.claude_code = original;
		}
	});
});

/**
 * F223 (plan:1103 [plan+]): every Codex and Copilot fixture must carry a
 * `_source` tag, and every `"docs"`-sourced one must have a matching
 * waiver documented in SPIKE.md — a fixture with no waiver trail is
 * indistinguishable from one nobody remembered to verify. (The plan's own
 * text names the two values `{"captured","docs"}`; the fixtures and
 * SPIKE.md consistently use `"live"` instead of `"captured"` — this
 * asserts against what's actually on disk, not the plan's paraphrase.)
 */
describe("F223 (plan:1103 [plan+]): fixture _source/SPIKE.md waiver pairing", () => {
	const FIXTURES_ROOT = join(import.meta.dir, "__fixtures__");
	const SPIKE_PATH = join(FIXTURES_ROOT, "SPIKE.md");
	const VALID_SOURCES = new Set(["live", "docs"]);

	function loadFixtures(agentDir: string): Array<{ event: string; source: unknown }> {
		const dir = join(FIXTURES_ROOT, agentDir);
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const content = JSON.parse(readFileSync(join(dir, f), "utf8")) as { _source?: unknown };
				return { event: f.replace(/\.json$/, ""), source: content._source };
			});
	}

	test('every fixture carries _source in {"live","docs"} — 12 Codex + 10 Copilot', () => {
		const codex = loadFixtures("codex");
		const copilot = loadFixtures("copilot");
		expect(codex.length).toBe(12);
		expect(copilot.length).toBe(10);
		for (const { event, source } of [...codex, ...copilot]) {
			const ok = typeof source === "string" && VALID_SOURCES.has(source);
			if (!ok) throw new Error(`${event}: _source=${JSON.stringify(source)} is not "live"/"docs"`);
			expect(ok).toBe(true);
		}
	});

	test("every docs-sourced Codex fixture has a matching SPIKE.md fixture-inventory table row", () => {
		const spike = readFileSync(SPIKE_PATH, "utf8");
		const codex = loadFixtures("codex");
		const docsEvents = codex.filter((f) => f.source === "docs");
		expect(docsEvents.length).toBeGreaterThan(0);
		for (const { event } of docsEvents) {
			// Matches the fixture-inventory table row: "| EventName | docs | ... |"
			const rowPattern = new RegExp(`^\\|\\s*${event}\\s*\\|\\s*docs\\s*\\|`, "m");
			const found = rowPattern.test(spike);
			if (!found) throw new Error(`no SPIKE.md waiver row found for Codex ${event}`);
			expect(found).toBe(true);
		}
	});

	test("Copilot's blanket docs-waiver statement covers all 10 events", () => {
		const spike = readFileSync(SPIKE_PATH, "utf8");
		const copilot = loadFixtures("copilot");
		// Every Copilot fixture shares one root cause (SPIKE.md fact 1's
		// org-policy 403) — SPIKE.md documents this as one blanket
		// statement, not 10 per-event table rows, so the check matches
		// that shape rather than demanding a row-per-event pattern that
		// doesn't exist in the doc.
		expect(copilot.every((f) => f.source === "docs")).toBe(true);
		expect(spike).toContain("src/server/services/agents/__fixtures__/copilot/");
		expect(spike).toMatch(/All 10 carry `?"_source":\s*"docs"`?/);
	});
});
