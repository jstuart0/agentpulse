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
		expect((out.tool_response as string).length).toBe(CAP_BYTES);
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

describe("F221 (xander, Medium): isCopilotEvent doesn't walk the prototype chain", () => {
	// `value in COPILOT_EVENT_TO_HOOK_EVENT` resolves inherited Object.prototype
	// members (constructor, __proto__, toString, hasOwnProperty) as if they
	// were legitimate keys. `?event=constructor` must not resolve to
	// anything — hookEventName falls back to "", exactly like an unknown
	// hint, not to Object's own constructor function.
	const prototypePollutionHints = ["constructor", "__proto__", "toString", "hasOwnProperty"];

	for (const hint of prototypePollutionHints) {
		test(`?event=${hint} produces no mapping (hook_event_name is empty, not a function/object)`, () => {
			const raw = asRaw({ sessionId: "s1", cwd: "/tmp" });
			const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, hint);
			expect(out.hook_event_name).toBe("");
			expect(typeof out.hook_event_name).toBe("string");
		});
	}

	test("no background error is counted for a prototype-chain hint (canonicalizeHookPayload's try/catch never fires)", () => {
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp" });
		// canonicalizeHookPayload is the outer, never-throws dispatcher — if
		// isCopilotEvent's prototype-chain lookup produced something
		// canonicalizeHookPayload's downstream construction couldn't handle
		// (e.g. tried to call a function), it would either throw (silently
		// swallowed, falling back to the raw body — itself a symptom) or
		// produce a garbage hook_event_name. Assert the well-formed,
		// canonicalized shape, not the raw passthrough.
		const out = canonicalizeHookPayload("copilot_cli", raw, "constructor");
		expect(out.session_id).toBe("s1");
		expect(out.hook_event_name).toBe("");
	});
});

describe("F220 (Low): non-string toolArgs/tool_input/toolResponse objects are capped too", () => {
	function bigObject(): Record<string, unknown> {
		return { command: "x".repeat(CAP_BYTES + 500) };
	}

	test("an oversized already-parsed toolArgs object is capped, not passed through unbounded", () => {
		const value = bigObject();
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: value });
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		const serialized = JSON.stringify(value);
		expect(out.tool_input).toEqual({ raw: serialized.slice(0, CAP_BYTES), truncated: true });
	});

	test("an oversized already-parsed tool_input (snake_case variant) object is capped", () => {
		const value = bigObject();
		const raw = asRaw({ session_id: "s1", cwd: "/tmp", tool_name: "shell", tool_input: value });
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		const serialized = JSON.stringify(value);
		expect(out.tool_input).toEqual({ raw: serialized.slice(0, CAP_BYTES), truncated: true });
	});

	test("a small object toolArgs is unaffected (still passes through, no wrapping)", () => {
		const value = { command: "echo hi" };
		const raw = asRaw({ sessionId: "s1", cwd: "/tmp", toolName: "shell", toolArgs: value });
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.tool_input).toEqual(value);
	});

	test("an oversized toolResponse object with no textResultForLlm is capped, not passed through unbounded", () => {
		const value = { unexpectedShape: "x".repeat(CAP_BYTES + 500) };
		const raw = asRaw({
			sessionId: "s1",
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: { command: "echo hi" },
			toolResponse: value,
		});
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		const serialized = JSON.stringify(value);
		expect(out.tool_response).toEqual({ raw: serialized.slice(0, CAP_BYTES), truncated: true });
	});
});

describe("F224 (Medium): the malformed-JSON toolArgs string branch", () => {
	test('toolArgs: "not json {" normalizes to {raw: "not json {"}, not silently dropped to {}', () => {
		const raw = asRaw({
			sessionId: "s1",
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: "not json {",
		});
		const out = HOOK_PAYLOAD_CANONICALIZERS.copilot_cli(raw, "postToolUse");
		expect(out.tool_input).toEqual({ raw: "not json {" });
	});
});
