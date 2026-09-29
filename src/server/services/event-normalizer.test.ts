import { describe, expect, spyOn, test } from "bun:test";
import type { HookEventPayload } from "../../shared/types.js";
import { normalizeHookEvent } from "./event-normalizer.js";

function payload(overrides: Partial<HookEventPayload>): HookEventPayload {
	return {
		session_id: "s1",
		hook_event_name: "SessionStart",
		...overrides,
	};
}

describe("normalizeHookEvent — permission events (Decision 4)", () => {
	test("PermissionRequest normalizes to permission_event, content names the tool", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
			"claude_code",
		);
		expect(event.category).toBe("permission_event");
		expect(event.content).not.toBeNull();
		expect(event.content).toContain("Bash");
	});

	test("PermissionDenied normalizes to permission_event with content distinguishable from the request", () => {
		const [requestEvent] = normalizeHookEvent(
			payload({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
			"claude_code",
		);
		const [deniedEvent] = normalizeHookEvent(
			payload({ hook_event_name: "PermissionDenied", tool_name: "Bash" }),
			"claude_code",
		);
		expect(deniedEvent.category).toBe("permission_event");
		expect(deniedEvent.content).not.toBeNull();
		expect(deniedEvent.content).not.toBe(requestEvent.content);
	});

	test("PermissionRequest with no tool_name degrades gracefully (no throw, non-null content)", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "PermissionRequest" }),
			"claude_code",
		);
		expect(event.category).toBe("permission_event");
		expect(event.content).not.toBeNull();
	});
});

describe("normalizeHookEvent — Notification (Decision 4: stays system_event)", () => {
	test("Notification normalizes to system_event, content reflects the message", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "Notification", message: "Waiting for your input" }),
			"claude_code",
		);
		expect(event.category).toBe("system_event");
		expect(event.content).toContain("Waiting for your input");
	});
});

describe("normalizeHookEvent — Interrupt (D12, Codex)", () => {
	test("Interrupt normalizes to system_event, content is 'Turn interrupted'", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "Interrupt", turn_id: "t1" }),
			"codex_cli",
		);
		expect(event.category).toBe("system_event");
		expect(event.content).toBe("Turn interrupted");
	});
});

describe("normalizeHookEvent — ErrorOccurred (Phase 6, Copilot D7)", () => {
	// RED at Phase 6's start commit: HookEventPayload doesn't export
	// error_message yet (compile error), and event-normalizer.ts's switch
	// has no ErrorOccurred case — it falls into the unknown-event default
	// branch (content: null, a console.warn) instead of surfacing the
	// error text.
	test("ErrorOccurred normalizes to system_event, content reflects error_message", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "ErrorOccurred", error_message: "example error message" }),
			"copilot_cli",
		);
		expect(event.category).toBe("system_event");
		expect(event.content).toBe("Error: example error message");
		expect(event.isNoise).toBe(false);
	});

	test("providerEventType is sourced from provider_event_name when present, not the canonical hook_event_name", () => {
		const [event] = normalizeHookEvent(
			payload({
				hook_event_name: "ErrorOccurred",
				error_message: "boom",
				provider_event_name: "errorOccurred",
			}),
			"copilot_cli",
		);
		expect(event.providerEventType).toBe("errorOccurred");
	});
});

describe("normalizeHookEvent — compaction events", () => {
	test("PreCompact without trigger", () => {
		const [event] = normalizeHookEvent(payload({ hook_event_name: "PreCompact" }), "claude_code");
		expect(event.category).toBe("system_event");
		expect(event.content).toBe("Context compaction started");
	});

	test("PreCompact with trigger reflects it in content", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "PreCompact", trigger: "auto" }),
			"claude_code",
		);
		expect(event.category).toBe("system_event");
		expect(event.content).toContain("auto");
	});

	test("PostCompact without trigger", () => {
		const [event] = normalizeHookEvent(payload({ hook_event_name: "PostCompact" }), "claude_code");
		expect(event.category).toBe("system_event");
		expect(event.content).toBe("Context compaction completed");
	});

	test("PostCompact with trigger reflects it in content", () => {
		const [event] = normalizeHookEvent(
			payload({ hook_event_name: "PostCompact", trigger: "manual" }),
			"claude_code",
		);
		expect(event.category).toBe("system_event");
		expect(event.content).toContain("manual");
	});
});

describe("normalizeHookEvent — PostToolUseFailure (Decision 3)", () => {
	test("routes through the tool_event branch, content distinguishes failure from success", () => {
		const [successEvent] = normalizeHookEvent(
			payload({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
			"claude_code",
		);
		const [failureEvent] = normalizeHookEvent(
			payload({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" }),
			"claude_code",
		);
		expect(failureEvent.category).toBe("tool_event");
		expect(failureEvent.content).not.toBeNull();
		expect(failureEvent.content).not.toBe(successEvent.content);
	});
});

describe("normalizeHookEvent — unknown event tolerance + log-once (F4)", () => {
	test("unknown event name still lands as a tolerated system_event, no throw", () => {
		expect(() =>
			normalizeHookEvent(payload({ hook_event_name: "BogusEvent" }), "claude_code"),
		).not.toThrow();
		const [event] = normalizeHookEvent(payload({ hook_event_name: "BogusEvent" }), "claude_code");
		expect(event.category).toBe("system_event");
	});

	test("logs a warning exactly once per distinct unknown event name", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			normalizeHookEvent(payload({ hook_event_name: "TotallyUnknownEventA" }), "claude_code");
			normalizeHookEvent(payload({ hook_event_name: "TotallyUnknownEventA" }), "claude_code");
			expect(warnSpy).toHaveBeenCalledTimes(1);

			normalizeHookEvent(payload({ hook_event_name: "TotallyUnknownEventB" }), "claude_code");
			expect(warnSpy).toHaveBeenCalledTimes(2);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
