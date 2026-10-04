/**
 * AGEN-69 phase 2a: every adapter reports why the provider stopped
 * (TC-2.4 to TC-2.6). The real adapters run against the stub server, which
 * sends each provider's own stop field; nothing about fetch is replaced.
 * D-M: a missing, null or unknown value is `other`, never `end`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type LlmStubServer,
	type WireShape,
	startLlmStubServer,
} from "../../../test-utils/llm-stub-server.js";
import { getAdapter } from "./registry.js";
import type { LlmStopReason, ProviderKind } from "./types.js";

const started: LlmStubServer[] = [];
afterEach(async () => {
	for (const s of started.splice(0)) {
		try {
			s.verify();
		} finally {
			await s.stop();
		}
	}
});

async function stopReasonFor(
	kind: ProviderKind,
	shape: WireShape,
	stop: string | null | undefined,
): Promise<{
	stopReason: LlmStopReason | undefined;
	text: string;
	inputTokens: number;
	outputTokens: number;
}> {
	const stub = startLlmStubServer();
	started.push(stub);
	stub.script(shape, { text: "the answer", stop, usage: { input: 11, output: 7 } });
	const adapter = getAdapter({ kind, apiKey: "k", baseUrl: stub.baseUrl(shape) });
	const res = await adapter.complete({
		systemPrompt: "sys",
		transcriptPrompt: "user",
		model: "m",
	});
	return {
		stopReason: res.stopReason,
		text: res.text,
		inputTokens: res.usage.inputTokens,
		outputTokens: res.usage.outputTokens,
	};
}

const MISSING = undefined;

describe("TC-2.4 OpenAI-compatible adapter stop reason", () => {
	const cases: Array<[string | null | undefined, LlmStopReason]> = [
		["stop", "end"],
		["length", "length"],
		["content_filter", "refusal"],
		[null, "other"],
		[MISSING, "other"],
		["tool_calls", "other"],
		["function_call", "other"],
		["something_new", "other"],
	];
	for (const [raw, expected] of cases) {
		test(`TC-2.4 finish_reason ${raw === undefined ? "(missing)" : JSON.stringify(raw)} gives ${expected}`, async () => {
			const out = await stopReasonFor("openai", "openai", raw);
			expect(out.stopReason).toBe(expected);
			expect(out.text).toBe("the answer");
			expect(out.inputTokens).toBe(11);
			expect(out.outputTokens).toBe(7);
		});
	}
});

describe("TC-2.5 Anthropic adapter stop reason", () => {
	const cases: Array<[string | null | undefined, LlmStopReason]> = [
		["end_turn", "end"],
		["stop_sequence", "end"],
		["max_tokens", "length"],
		["refusal", "refusal"],
		["tool_use", "other"],
		["pause_turn", "other"],
		[null, "other"],
		[MISSING, "other"],
		["something_new", "other"],
	];
	for (const [raw, expected] of cases) {
		test(`TC-2.5 stop_reason ${raw === undefined ? "(missing)" : JSON.stringify(raw)} gives ${expected}`, async () => {
			const out = await stopReasonFor("anthropic", "anthropic", raw);
			expect(out.stopReason).toBe(expected);
			expect(out.text).toBe("the answer");
			expect(out.inputTokens).toBe(11);
			expect(out.outputTokens).toBe(7);
		});
	}
});

describe("TC-2.6 Cohere adapter stop reason", () => {
	const cases: Array<[string | null | undefined, LlmStopReason]> = [
		["COMPLETE", "end"],
		["STOP_SEQUENCE", "end"],
		["MAX_TOKENS", "length"],
		["ERROR", "other"],
		["TOOL_CALL", "other"],
		[null, "other"],
		[MISSING, "other"],
		["something_new", "other"],
	];
	for (const [raw, expected] of cases) {
		test(`TC-2.6 finish_reason ${raw === undefined ? "(missing)" : JSON.stringify(raw)} gives ${expected}`, async () => {
			const out = await stopReasonFor("cohere", "cohere", raw);
			expect(out.stopReason).toBe(expected);
			expect(out.text).toBe("the answer");
			expect(out.inputTokens).toBe(11);
			expect(out.outputTokens).toBe(7);
		});
	}
});
