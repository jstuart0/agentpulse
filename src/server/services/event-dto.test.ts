import { describe, expect, test } from "bun:test";
import { toSessionEventDto } from "./event-dto.js";

const FULL_ROW = {
	id: 42,
	sessionId: "s1",
	eventType: "PostToolUse",
	category: "tool_event",
	source: "observed_hook",
	content: "ran Bash",
	isNoise: false,
	providerEventType: null,
	toolName: "Bash",
	toolInput: { command: "true" },
	toolResponse: "ok",
	rawPayload: { tool_use_id: "u1" },
	createdAt: "2026-09-28 12:00:00",
};

describe("toSessionEventDto (DTO-1)", () => {
	test("returns exactly the SessionEvent field set, with no dedupKey and no unknown columns", () => {
		const dto = toSessionEventDto({
			...FULL_ROW,
			dedupKey: "t:abc",
			someFutureColumn: 1,
		});

		expect(Object.keys(dto).sort()).toEqual(
			[
				"category",
				"content",
				"createdAt",
				"eventType",
				"id",
				"isNoise",
				"providerEventType",
				"rawPayload",
				"sessionId",
				"source",
				"toolInput",
				"toolName",
				"toolResponse",
			].sort(),
		);
		expect("dedupKey" in dto).toBe(false);
		expect((dto as unknown as Record<string, unknown>).someFutureColumn).toBeUndefined();
	});

	test("preserves the field values verbatim", () => {
		const dto = toSessionEventDto({ ...FULL_ROW, dedupKey: null });
		expect(dto).toEqual({
			id: 42,
			sessionId: "s1",
			eventType: "PostToolUse",
			category: "tool_event",
			source: "observed_hook",
			content: "ran Bash",
			isNoise: false,
			providerEventType: null,
			toolName: "Bash",
			toolInput: { command: "true" },
			toolResponse: "ok",
			rawPayload: { tool_use_id: "u1" },
			createdAt: "2026-09-28 12:00:00",
		});
	});

	test("null toolInput and missing rawPayload default sensibly", () => {
		const dto = toSessionEventDto({
			...FULL_ROW,
			toolInput: null,
			rawPayload: undefined as unknown as Record<string, unknown>,
		});
		expect(dto.toolInput).toBeNull();
		expect(dto.rawPayload).toEqual({});
	});
});
