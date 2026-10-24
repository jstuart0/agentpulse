/**
 * AGEN-79: an OpenAI-compatible reply with no `content` is an error, never an
 * answer. The adapter used to hand back the model's `reasoning` field when
 * `content` was empty, so a reasoning model that ran out of tokens mid-thought
 * showed its truncated chain of thought as the reply.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import { LlmError, type LlmRequest, type LlmStreamEvent, type ProviderKind } from "./types.js";

const originalFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>> = [];

function mockJson(payload: unknown): void {
	globalThis.fetch = ((_url: string, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
	}) as unknown as typeof globalThis.fetch;
}

function mockSse(frames: unknown[]): void {
	globalThis.fetch = ((_url: string, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		const text = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;
		return Promise.resolve(
			new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		);
	}) as unknown as typeof globalThis.fetch;
}

const REQUEST: LlmRequest = {
	systemPrompt: "sys",
	transcriptPrompt: "user",
	model: "test-model",
};

function adapter(kind: ProviderKind = "openai_compatible") {
	return createOpenAICompatibleAdapter({ apiKey: "", baseUrl: "http://llm.example.test/v1", kind });
}

async function rejection(promise: Promise<unknown>): Promise<LlmError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof LlmError) return err;
		throw err;
	}
	throw new Error("expected the call to reject");
}

function streamOf(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
	const stream = adapter().completeStream;
	if (!stream) throw new Error("adapter has no completeStream");
	return stream.call(adapter(), request);
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) {
		// consume
	}
}

beforeEach(() => {
	bodies = [];
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("complete(): empty content is an error", () => {
	test("empty content with finish_reason=length and a reasoning field is empty_output, not the answer", async () => {
		mockJson({
			choices: [
				{
					message: { content: "", reasoning: "Thinking Process:\n\n1. Analyze the Request" },
					finish_reason: "length",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 800 },
		});
		const err = await rejection(adapter().complete(REQUEST));
		expect(err.subType).toBe("empty_output");
		expect(err.message).toContain("ran out of output tokens while reasoning");
		expect(err.message).toContain("finish_reason=length");
		// The chain of thought must not leak into the error either.
		expect(err.message).not.toContain("Analyze the Request");
	});

	test("null content and whitespace-only content are errors too", async () => {
		for (const content of [null, "  \n"]) {
			mockJson({ choices: [{ message: { content }, finish_reason: "stop" }] });
			const err = await rejection(adapter().complete(REQUEST));
			expect(err.subType).toBe("empty_output");
			expect(err.message).toContain("returned nothing");
		}
	});

	test("reasoning-only output that stopped normally is still an error", async () => {
		mockJson({
			choices: [{ message: { content: null, reasoning: "hmm" }, finish_reason: "stop" }],
		});
		const err = await rejection(adapter().complete(REQUEST));
		expect(err.subType).toBe("empty_output");
		expect(err.message).toContain("returned only reasoning");
	});

	test("a content-filter stop with no text is returned for the caller to treat as a refusal", async () => {
		mockJson({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] });
		const res = await adapter().complete(REQUEST);
		expect(res.text).toBe("");
		expect(res.stopReason).toBe("refusal");
	});

	test("positive control: real content is returned, and so is a length-truncated partial answer", async () => {
		mockJson({
			choices: [
				{ message: { content: "The answer.", reasoning: "ignored" }, finish_reason: "stop" },
			],
		});
		expect((await adapter().complete(REQUEST)).text).toBe("The answer.");

		mockJson({ choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] });
		const partial = await adapter().complete(REQUEST);
		expect(partial.text).toBe('{"a":');
		expect(partial.stopReason).toBe("length");
	});
});

describe("completeStream(): the same rule, and the same reasoning opt-out", () => {
	test("a stream that carries only reasoning deltas ends in empty_output", async () => {
		mockSse([
			{ choices: [{ delta: { reasoning: "Thinking Process:" } }] },
			{ choices: [{ delta: { reasoning: " 1. Analyze" }, finish_reason: "length" }] },
		]);
		const err = await rejection(drain(streamOf(REQUEST)));
		expect(err.subType).toBe("empty_output");
		expect(err.message).toContain("ran out of output tokens while reasoning");
	});

	test("positive control: a stream with content completes", async () => {
		mockSse([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
		]);
		const events: string[] = [];
		for await (const evt of streamOf(REQUEST)) {
			events.push(evt.kind === "delta" ? evt.text : `done:${evt.response.text}`);
		}
		expect(events).toEqual(["Hel", "lo", "done:Hello"]);
	});

	test("disableReasoning reaches the stream body, as it does for complete()", async () => {
		mockSse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]);
		await drain(streamOf({ ...REQUEST, disableReasoning: true }));
		expect(bodies[0]?.reasoning_effort).toBe("none");
		expect(bodies[0]?.stream).toBe(true);
	});
});

describe("request body", () => {
	test("reasoning_effort is sent only when the caller disables reasoning", async () => {
		mockJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
		await adapter().complete(REQUEST);
		await adapter().complete({ ...REQUEST, disableReasoning: true });
		expect(bodies[0]?.reasoning_effort).toBeUndefined();
		expect(bodies[1]?.reasoning_effort).toBe("none");
		// The server-specific opt-outs go out on every call.
		expect(bodies[0]?.think).toBe(false);
		expect(bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});

describe("an empty reply carries the usage the provider billed (AGEN-79)", () => {
	test("complete(): reported tokens are on the error", async () => {
		mockJson({
			choices: [{ message: { content: "", reasoning: "hmm" }, finish_reason: "length" }],
			usage: { prompt_tokens: 1200, completion_tokens: 800 },
		});
		const err = await rejection(adapter().complete(REQUEST));
		expect(err.usage).toEqual({ inputTokens: 1200, outputTokens: 800, estimated: false });
	});

	test("complete(): with no usage reported it is estimated, not dropped", async () => {
		mockJson({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
		const err = await rejection(adapter().complete(REQUEST));
		expect(err.usage?.estimated).toBe(true);
	});

	test("completeStream(): the final usage chunk is on the error", async () => {
		mockSse([
			{ choices: [{ delta: { reasoning: "think" }, finish_reason: "length" }] },
			{ choices: [], usage: { prompt_tokens: 50, completion_tokens: 800 } },
		]);
		const err = await rejection(drain(streamOf(REQUEST)));
		expect(err.usage).toEqual({ inputTokens: 50, outputTokens: 800, estimated: false });
	});
});

describe("a refusal in message.refusal is a refusal, not an empty output (AGEN-79)", () => {
	test("complete(): null content with a refusal string", async () => {
		mockJson({
			choices: [
				{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" },
			],
			usage: { prompt_tokens: 5, completion_tokens: 6 },
		});
		const res = await adapter().complete(REQUEST);
		expect(res.stopReason).toBe("refusal");
		expect(res.text).toBe("I can't help with that.");
		expect(res.usage.outputTokens).toBe(6);
	});

	test("completeStream(): refusal deltas with no content", async () => {
		mockSse([
			{ choices: [{ delta: { refusal: "I can't " } }] },
			{ choices: [{ delta: { refusal: "help." }, finish_reason: "stop" }] },
		]);
		const events: LlmStreamEvent[] = [];
		for await (const evt of streamOf(REQUEST)) events.push(evt);
		const done = events.find((e) => e.kind === "done");
		expect(done?.kind === "done" && done.response.stopReason).toBe("refusal");
		expect(done?.kind === "done" && done.response.text).toBe("I can't help.");
	});

	test("real content wins over a refusal field, and an empty refusal is still empty output", async () => {
		mockJson({
			choices: [{ message: { content: "Answer", refusal: "ignored" }, finish_reason: "stop" }],
		});
		expect((await adapter().complete(REQUEST)).stopReason).toBe("end");
		mockJson({ choices: [{ message: { content: null, refusal: "  " }, finish_reason: "stop" }] });
		expect((await rejection(adapter().complete(REQUEST))).subType).toBe("empty_output");
	});
});

describe("request fields follow what each provider kind accepts (AGEN-79)", () => {
	async function bodyFor(kind: ProviderKind, disableReasoning: boolean) {
		mockJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
		bodies = [];
		await adapter(kind).complete({ ...REQUEST, disableReasoning });
		return bodies[0] ?? {};
	}

	test("think and chat_template_kwargs go only to self-hosted servers", async () => {
		const selfHosted = await bodyFor("openai_compatible", true);
		expect(selfHosted.think).toBe(false);
		expect(selfHosted.chat_template_kwargs).toEqual({ enable_thinking: false });
		for (const kind of ["openai", "google", "openrouter"] as const) {
			const body = await bodyFor(kind, true);
			expect("think" in body).toBe(false);
			expect("chat_template_kwargs" in body).toBe(false);
		}
	});

	test("reasoning_effort none goes to self-hosted servers and OpenRouter, not to OpenAI or Google", async () => {
		expect((await bodyFor("openai_compatible", true)).reasoning_effort).toBe("none");
		expect((await bodyFor("openrouter", true)).reasoning_effort).toBe("none");
		expect("reasoning_effort" in (await bodyFor("openai", true))).toBe(false);
		expect("reasoning_effort" in (await bodyFor("google", true))).toBe(false);
	});

	test("without disableReasoning no kind gets reasoning_effort", async () => {
		for (const kind of ["openai_compatible", "openrouter", "openai", "google"] as const) {
			expect("reasoning_effort" in (await bodyFor(kind, false))).toBe(false);
		}
	});
});
