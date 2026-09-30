import { describe, expect, test } from "bun:test";
import type { AgentType } from "../../shared/types.js";
import { parseTranscriptDelta } from "./transcript-sync.js";

const codexAgentMessageLine = JSON.stringify({
	type: "event_msg",
	timestamp: "2026-09-28T00:00:00Z",
	payload: { type: "agent_message", message: "hello from codex", phase: "final" },
});

describe("parseTranscriptDelta — D5 Pattern A' TRANSCRIPT_PARSERS map", () => {
	test("codex_cli parses a real Codex-shaped line into an event", () => {
		const events = parseTranscriptDelta("codex_cli", [codexAgentMessageLine]);
		expect(events.length).toBe(1);
	});

	test("an agent type with no registered parser gets zero events, even on Codex-shaped content — proving the Codex parser is not invoked as a fallback", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating a future observed-only agent type not yet in AgentType
		const events = parseTranscriptDelta("copilot_cli" as any as AgentType, [codexAgentMessageLine]);
		expect(events).toEqual([]);
	});
});
