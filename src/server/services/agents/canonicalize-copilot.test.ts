/**
 * Phase 6 (D7/F28/F30): the copilot_cli canonicalizer entry in
 * HOOK_PAYLOAD_CANONICALIZERS — the Phase 1 seam
 * (scripts/canonicalize.test.ts) plugs Copilot's camelCase-to-snake_case
 * conversion in here without touching ingest.ts or either existing entry.
 *
 * RED at Phase 6's start commit: HOOK_PAYLOAD_CANONICALIZERS has no
 * copilot_cli key yet (Record<AgentType, Canonicalizer> is missing an
 * entry — a compile error once AgentType gains "copilot_cli" — and at
 * runtime canonicalizeHookPayload("copilot_cli", ...) falls through the
 * `if (!canonicalizer) return raw` guard, so every assertion below that
 * expects real normalization fails).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CopilotEvent, HookEventPayload } from "../../../shared/types.js";
import { COPILOT_EVENT_TO_HOOK_EVENT } from "../../../shared/types.js";
import { HOOK_PAYLOAD_CANONICALIZERS, canonicalizeHookPayload } from "./canonicalize.js";

const COPILOT_FIXTURES_DIR = join(import.meta.dir, "__fixtures__/copilot");
const CAP_BYTES = 64 * 1024;

function asRaw(obj: Record<string, unknown>): HookEventPayload {
	return obj as unknown as HookEventPayload;
}

describe("Phase 6 contract item 1: one canonicalizer test per Copilot fixture, set-equality with CopilotEvent", () => {
	const files = readdirSync(COPILOT_FIXTURES_DIR).filter((f) => f.endsWith(".json"));

	test("fixture population set-equals CopilotEvent (10 events)", () => {
		const fixtureEvents = files.map((f) => f.replace(/\.json$/, "")).sort();
		const declaredEvents = Object.keys(COPILOT_EVENT_TO_HOOK_EVENT).sort();
		expect(fixtureEvents).toEqual(declaredEvents);
	});

	for (const file of files) {
		const eventName = file.replace(/\.json$/, "") as CopilotEvent;
		test(`${eventName}.json canonicalizes to hook_event_name ${COPILOT_EVENT_TO_HOOK_EVENT[eventName] ?? "<unmapped>"}`, () => {
			const raw = JSON.parse(readFileSync(join(COPILOT_FIXTURES_DIR, file), "utf8")) as Record<
				string,
				unknown
			>;
			const out = canonicalizeHookPayload("copilot_cli", asRaw(raw), eventName);
			expect(out.hook_event_name).toBe(COPILOT_EVENT_TO_HOOK_EVENT[eventName]);
			expect(out.session_id).toBe(raw.sessionId as string);
		});
	}
});

describe("Phase 6 contract item 2: dual-shape tolerance (camelCase vs Pascal/snake_case)", () => {
	test("camelCase postToolUse with a JSON-string toolArgs normalizes to an object", () => {
		const raw = asRaw({
			sessionId: "s1",
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: JSON.stringify({ command: "echo hi" }),
			toolResponse: "hi\n",
		});
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.hook_event_name).toBe("PostToolUse");
		expect(out.session_id).toBe("s1");
		expect(out.cwd).toBe("/tmp");
		expect(out.tool_name).toBe("shell");
		expect(out.tool_input).toEqual({ command: "echo hi" });
		expect(out.tool_response).toBe("hi\n");
	});

	test("the Pascal/snake_case variant (hook_event_name + snake fields) normalizes identically", () => {
		const raw = asRaw({
			session_id: "s1",
			cwd: "/tmp",
			hook_event_name: "PostToolUse",
			tool_name: "shell",
			tool_input: JSON.stringify({ command: "echo hi" }),
			tool_response: "hi\n",
		});
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.hook_event_name).toBe("PostToolUse");
		expect(out.session_id).toBe("s1");
		expect(out.cwd).toBe("/tmp");
		expect(out.tool_name).toBe("shell");
		expect(out.tool_input).toEqual({ command: "echo hi" });
		expect(out.tool_response).toBe("hi\n");
	});
});

describe('Phase 6 contract item 3 (F30): toolArgs:"" is the ??-boundary case', () => {
	test('an empty string toolArgs normalizes to {raw:""}, not dropped/undefined', () => {
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: "" });
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.tool_input).toEqual({ raw: "" });
	});
});

describe("Phase 6 contract item 4 (F28): 64 KiB caps, no premature JSON.parse", () => {
	test("a >64 KiB toolArgs string caps to {raw: first 64 KiB, truncated:true} without ever parsing it", () => {
		// Deliberately valid JSON if parsed — the assertion that matters is
		// that JSON.parse is never called on this input at all, not that
		// parsing would have failed.
		const oversized = `{"command":"${"x".repeat(CAP_BYTES + 500)}"}`;
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: oversized });
		const parseSpy = spyOn(JSON, "parse");
		try {
			const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
			expect(parseSpy).not.toHaveBeenCalled();
			expect(out.tool_input).toEqual({ raw: oversized.slice(0, CAP_BYTES), truncated: true });
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("toolResponse is sliced to 64 KiB before assignment", () => {
		const hugeResponse = "y".repeat(CAP_BYTES + 1000);
		const raw = asRaw({
			sessionId: "s1",
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: { command: "echo hi" },
			toolResponse: hugeResponse,
		});
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.tool_response?.length).toBe(CAP_BYTES);
		expect(out.tool_response).toBe(hugeResponse.slice(0, CAP_BYTES));
	});

	test("completes in well under 50ms against a ~1 MiB toolArgs string (median of 5 runs)", () => {
		const oneMiB = "z".repeat(1024 * 1024);
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: oneMiB });
		const samples: number[] = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(50);
	});
});

describe("Phase 6 contract item 5: null/array/number toolArgs pass through unchanged, no throw", () => {
	const cases: Array<[string, unknown]> = [
		["null", null],
		["array", [1, 2, 3]],
		["number", 42],
	];
	for (const [label, value] of cases) {
		test(`toolArgs:${label} is returned unchanged`, () => {
			const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: value });
			expect(() => HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse")).not.toThrow();
			const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
			expect(out.tool_input as unknown).toEqual(value as never);
		});
	}
});
