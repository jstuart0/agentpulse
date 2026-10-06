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
import { createAnthropicAdapter } from "./anthropic.js";
import { createCohereAdapter } from "./cohere.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import {
	type LlmAdapter,
	type LlmStopReason,
	type LlmStreamEvent,
	mapStopReason,
} from "./types.js";

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
	// The adapters are built directly rather than through registry.ts; the
	// registry canary (ask/llm-registry-canary.test.ts) covers that path.
	const baseUrl = stub.baseUrl(shape);
	const adapter: LlmAdapter =
		shape === "openai"
			? createOpenAICompatibleAdapter({ apiKey: "k", baseUrl, kind: "openai" })
			: shape === "anthropic"
				? createAnthropicAdapter({ apiKey: "k", baseUrl })
				: createCohereAdapter({ apiKey: "k", baseUrl });
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
			const out = await stopReasonFor("openai", raw);
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
			const out = await stopReasonFor("anthropic", raw);
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
			const out = await stopReasonFor("cohere", raw);
			expect(out.stopReason).toBe(expected);
			expect(out.text).toBe("the answer");
			expect(out.inputTokens).toBe(11);
			expect(out.outputTokens).toBe(7);
		});
	}
});

describe("P2-23 OpenAI-compatible stream path keeps the stop reason", () => {
	async function streamDone(answer: {
		stop?: string | null;
		pieces?: string[];
		usage?: { input: number; output: number };
	}) {
		const stub = startLlmStubServer();
		started.push(stub);
		stub.script("openai", {
			text: (answer.pieces ?? ["the answer"]).join(""),
			streamPieces: answer.pieces,
			stop: answer.stop,
			usage: answer.usage,
		});
		const adapter = createOpenAICompatibleAdapter({
			apiKey: "k",
			baseUrl: stub.baseUrl("openai"),
			kind: "openai",
		});
		const events: LlmStreamEvent[] = [];
		for await (const e of adapter.completeStream?.({
			systemPrompt: "sys",
			transcriptPrompt: "user",
			model: "m",
		}) ?? []) {
			events.push(e);
		}
		const done = events.at(-1);
		if (!done || done.kind !== "done") throw new Error("the stream did not end with done");
		return {
			deltas: events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text),
			response: done.response,
			request: JSON.parse(stub.requests("openai")[0].body),
		};
	}

	test("P2-23 finish_reason length on the last content chunk survives a trailing usage-only chunk with choices []", async () => {
		const out = await streamDone({
			stop: "length",
			pieces: ["The ans", "wer is cut"],
			usage: { input: 11, output: 7 },
		});
		expect(out.response.stopReason).toBe("length");
		expect(out.response.text).toBe("The answer is cut");
		expect(out.deltas).toEqual(["The ans", "wer is cut"]);
		expect(out.response.usage).toMatchObject({
			inputTokens: 11,
			outputTokens: 7,
			estimated: false,
		});
		expect(out.request.stream).toBe(true);
	});

	test("P2-23 the other stop values map as they do without streaming", async () => {
		const cases: Array<[string | null | undefined, LlmStopReason]> = [
			["stop", "end"],
			["content_filter", "refusal"],
			["tool_calls", "other"],
			[null, "other"],
			[undefined, "other"],
		];
		for (const [raw, expected] of cases) {
			const out = await streamDone({ stop: raw, usage: { input: 1, output: 1 } });
			expect(out.response.stopReason, String(raw)).toBe(expected);
		}
	});

	test("P2-23 a stream with no usage chunk still reports the stop reason, with estimated usage", async () => {
		const out = await streamDone({ stop: "length", pieces: ["a", "b"] });
		expect(out.response.stopReason).toBe("length");
		expect(out.response.usage.estimated).toBe(true);
	});
});

describe("P2-25 mapStopReason looks only at the adapter's own table", () => {
	const table = { stop: "end", length: "length" } as const;

	test("P2-25 names inherited from Object.prototype map to other", () => {
		for (const raw of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
			expect(mapStopReason(raw, table), raw).toBe("other");
		}
	});

	test("P2-25 listed values map, and anything that is not a string is other", () => {
		expect(mapStopReason("stop", table)).toBe("end");
		expect(mapStopReason("length", table)).toBe("length");
		for (const raw of [undefined, null, 1, {}, ["stop"], Symbol("stop")]) {
			expect(mapStopReason(raw, table)).toBe("other");
		}
	});

	test("P2-25 a provider that really sends constructor as a stop value gets other from every adapter", async () => {
		for (const shape of ["openai", "anthropic", "cohere"] as const) {
			expect((await stopReasonFor(shape, "constructor")).stopReason, shape).toBe("other");
			expect((await stopReasonFor(shape, "toString")).stopReason, shape).toBe("other");
		}
	});
});
