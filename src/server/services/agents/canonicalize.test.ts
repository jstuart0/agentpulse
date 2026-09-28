import { describe, expect, test } from "bun:test";
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
