import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createAnthropicAdapter } from "./anthropic.js";
import { createCohereAdapter } from "./cohere.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import { priceCompletion } from "./pricing.js";
import { LlmError, estimateTokens } from "./types.js";

const originalFetch = globalThis.fetch;
let capturedRequests: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(response: Response | (() => Response)) {
	globalThis.fetch = ((url: string, init?: RequestInit) => {
		capturedRequests.push({ url: String(url), init: init ?? {} });
		return Promise.resolve(typeof response === "function" ? response() : response);
	}) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
	capturedRequests = [];
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("anthropic adapter", () => {
	test("sends x-api-key and cache_control system block", async () => {
		mockFetch(
			new Response(
				JSON.stringify({
					content: [{ type: "text", text: "hi" }],
					usage: { input_tokens: 10, output_tokens: 2 },
				}),
				{ status: 200 },
			),
		);
		const adapter = createAnthropicAdapter({ apiKey: "sk-ant-test" });
		const res = await adapter.complete({
			systemPrompt: "You are a watcher",
			transcriptPrompt: "some events",
			model: "claude-sonnet-4-6",
		});
		expect(res.text).toBe("hi");
		expect(res.usage.inputTokens).toBe(10);
		expect(res.usage.estimated).toBe(false);
		const [req] = capturedRequests;
		expect((req.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
		const body = JSON.parse(String(req.init.body));
		expect(body.system[0].cache_control.type).toBe("ephemeral");
		expect(body.messages[0].content).toBe("some events");
	});

	test("normalizes 401 to permanent_auth", async () => {
		mockFetch(new Response("unauthorized", { status: 401 }));
		const adapter = createAnthropicAdapter({ apiKey: "bad" });
		const err = await adapter
			.complete({
				systemPrompt: "x",
				transcriptPrompt: "y",
				model: "claude-sonnet-4-6",
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		const llm = err as LlmError;
		expect(llm.subType).toBe("permanent_auth");
		expect(llm.status).toBe(401);
	});

	test("normalizes 429 to transient_rate_limit", async () => {
		mockFetch(new Response("slow down", { status: 429 }));
		const adapter = createAnthropicAdapter({ apiKey: "ok" });
		const err = await adapter
			.complete({
				systemPrompt: "x",
				transcriptPrompt: "y",
				model: "claude-sonnet-4-6",
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		expect((err as LlmError).subType).toBe("transient_rate_limit");
	});

	test("normalizes 500 to transient_timeout (retryable)", async () => {
		mockFetch(new Response("boom", { status: 503 }));
		const adapter = createAnthropicAdapter({ apiKey: "ok" });
		const err = await adapter
			.complete({
				systemPrompt: "x",
				transcriptPrompt: "y",
				model: "claude-sonnet-4-6",
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		expect((err as LlmError).subType).toBe("transient_timeout");
	});

	test("estimates tokens when usage is missing", async () => {
		mockFetch(
			new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), {
				status: 200,
			}),
		);
		const adapter = createAnthropicAdapter({ apiKey: "ok" });
		const res = await adapter.complete({
			systemPrompt: "sys",
			transcriptPrompt: "twelve chars", // ~3 tokens est
			model: "claude-sonnet-4-6",
		});
		expect(res.usage.estimated).toBe(true);
		expect(res.usage.inputTokens).toBeGreaterThan(0);
	});
});

describe("openai-compatible adapter", () => {
	test("posts standard chat completions shape", async () => {
		mockFetch(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "ok" } }],
					usage: { prompt_tokens: 5, completion_tokens: 1 },
				}),
				{ status: 200 },
			),
		);
		const adapter = createOpenAICompatibleAdapter({
			apiKey: "sk-test",
			baseUrl: "http://localhost:11434/v1",
		});
		const res = await adapter.complete({
			systemPrompt: "sys",
			transcriptPrompt: "body",
			model: "qwen2.5:7b",
		});
		expect(res.text).toBe("ok");
		const [req] = capturedRequests;
		expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
		const body = JSON.parse(String(req.init.body));
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[1].role).toBe("user");
		expect(body.model).toBe("qwen2.5:7b");
		expect((req.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
	});

	test("uses fallback 'ollama' token when apiKey is empty", async () => {
		mockFetch(
			new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
		);
		const adapter = createOpenAICompatibleAdapter({
			apiKey: "",
			baseUrl: "http://localhost:11434/v1",
		});
		await adapter.complete({
			systemPrompt: "s",
			transcriptPrompt: "u",
			model: "llama3.1",
		});
		const [req] = capturedRequests;
		expect((req.init.headers as Record<string, string>).Authorization).toBe("Bearer ollama");
	});

	test("normalizes auth errors", async () => {
		mockFetch(new Response("no auth", { status: 403 }));
		const adapter = createOpenAICompatibleAdapter({
			apiKey: "",
			baseUrl: "https://api.example/v1",
		});
		const err = await adapter
			.complete({ systemPrompt: "s", transcriptPrompt: "u", model: "x" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		expect((err as LlmError).subType).toBe("permanent_auth");
	});
});

describe("token estimator", () => {
	test("is monotonic", () => {
		expect(estimateTokens("")).toBe(1);
		expect(estimateTokens("short")).toBeLessThan(estimateTokens("a much longer string of words"));
	});
});

describe("pricing", () => {
	test("free for openai_compatible regardless of model", () => {
		expect(
			priceCompletion("openai_compatible", "qwen2.5:7b", {
				inputTokens: 100_000,
				outputTokens: 10_000,
				estimated: false,
			}),
		).toBe(0);
	});

	test("charges anthropic sonnet correctly", () => {
		const cents = priceCompletion("anthropic", "claude-sonnet-4-6", {
			inputTokens: 1_000_000,
			outputTokens: 200_000,
			estimated: false,
		});
		// 1M * 300c/1M + 200k * 1500c/1M = 300 + 300 = 600c
		expect(cents).toBe(600);
	});

	test("subtracts cached reads from input cost and adds cache read price", () => {
		const cents = priceCompletion("anthropic", "claude-sonnet-4-6", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 500_000,
			estimated: false,
		});
		// billed input 500k * 300 + cached 500k * 30 = 150 + 15 = 165c
		expect(cents).toBe(165);
	});

	test("falls back to a default rate for unknown models", () => {
		const cents = priceCompletion("openai", "unknown-exotic-model", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// Decision 1: fallback raised to sonnet-class 300c/1500c.
		// 1M * 300c/1M + 1M * 1500c/1M = 300 + 1500 = 1800c
		expect(cents).toBe(1800);
	});

	test("fallback rate applies Decision 1's raised input rate", () => {
		const cents = priceCompletion("openai", "some-brand-new-unlisted-model", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			estimated: false,
		});
		expect(cents).toBe(300);
	});

	test("fallback rate includes cache-read pricing for unmatched models", () => {
		const cents = priceCompletion("openai", "yet-another-unlisted-model", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 500_000,
			estimated: false,
		});
		// billed input 500k * 300c/1M + cached 500k * 30c/1M = 150 + 15 = 165c
		expect(cents).toBe(165);
	});

	test("logs fallback pricing exactly once per unmatched model name", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			priceCompletion("openai", "log-once-model-a", {
				inputTokens: 1000,
				outputTokens: 0,
				estimated: false,
			});
			priceCompletion("openai", "log-once-model-a", {
				inputTokens: 1000,
				outputTokens: 0,
				estimated: false,
			});
			expect(warnSpy).toHaveBeenCalledTimes(1);

			priceCompletion("openai", "log-once-model-b", {
				inputTokens: 1000,
				outputTokens: 0,
				estimated: false,
			});
			expect(warnSpy).toHaveBeenCalledTimes(2);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("returns zero cost for zero tokens on a matched rate", () => {
		const cents = priceCompletion("anthropic", "claude-sonnet-4-6", {
			inputTokens: 0,
			outputTokens: 0,
			estimated: false,
		});
		expect(cents).toBe(0);
	});

	test("returns zero cost for zero tokens on the fallback rate", () => {
		const cents = priceCompletion("openai", "zero-token-unlisted-model", {
			inputTokens: 0,
			outputTokens: 0,
			estimated: false,
		});
		expect(cents).toBe(0);
	});

	test("clamps billed input at zero when cacheReadTokens exceeds inputTokens", () => {
		const cents = priceCompletion("anthropic", "claude-sonnet-4-6", {
			inputTokens: 100,
			outputTokens: 0,
			cacheReadTokens: 1_000_000,
			estimated: false,
		});
		// cache-only cost: 1_000_000 * 30c/1M = 30c. Malformed usage (more cache
		// reads reported than input tokens) must not discount below that floor.
		expect(cents).toBe(30);
	});

	test("charges claude-sonnet-5 at its own coded rate, not by falling through to fallback", () => {
		// FALLBACK_RATE is numerically identical to sonnet-5's coded rate
		// (both {300,1500,30}), so the literal-cents assertion alone can't
		// distinguish a matched /^claude-sonnet-5/ from a typo'd regex that
		// silently falls through — the warn spy is the only black-box signal
		// that separates the two.
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const cents = priceCompletion("anthropic", "claude-sonnet-5", {
				inputTokens: 1_000_000,
				outputTokens: 200_000,
				estimated: false,
			});
			// sonnet-4.5 list price carried forward: 1M*300c + 200k*1500c/1M = 300+300 = 600c
			expect(cents).toBe(600);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("charges claude-fable-5 at its own coded rate, not the fallback", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const cents = priceCompletion("anthropic", "claude-fable-5", {
				inputTokens: 1_000_000,
				outputTokens: 200_000,
				estimated: false,
			});
			// conservative opus-class rate (Decision 2, unverified 2026-07-17):
			// 1M*1500c + 200k*7500c/1M = 1500+1500 = 3000c
			expect(cents).toBe(3000);
			expect(cents).not.toBe(600); // must not silently fall through to the fallback/sonnet rate
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("orders claude-haiku-4-5 before the haiku-4 prefix pattern", () => {
		const cents = priceCompletion("anthropic", "claude-haiku-4-5", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			estimated: false,
		});
		// haiku-4-5 rate (100c), not haiku-4's prefix-matched 80c
		expect(cents).toBe(100);
	});

	test("orders a dated claude-haiku-4-5 successor before the haiku-4 prefix pattern", () => {
		const cents = priceCompletion("anthropic", "claude-haiku-4-5-20260115", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			estimated: false,
		});
		expect(cents).toBe(100);
	});

	test("still charges plain claude-haiku-4 at the unchanged haiku-4 rate", () => {
		const cents = priceCompletion("anthropic", "claude-haiku-4-1-20250101", {
			inputTokens: 1_000_000,
			outputTokens: 0,
			estimated: false,
		});
		expect(cents).toBe(80);
	});

	test("charges gpt-5-nano at its own coded rate", () => {
		const cents = priceCompletion("openai", "gpt-5-nano", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// 1M*5c/1M + 1M*40c/1M = 5+40 = 45c
		expect(cents).toBe(45);
	});

	test("charges gpt-5-mini at its own coded rate, not the generic gpt-5 rate", () => {
		const cents = priceCompletion("openai", "gpt-5-mini", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// 1M*25c/1M + 1M*200c/1M = 25+200 = 225c
		expect(cents).toBe(225);
		expect(cents).not.toBe(1125); // the generic gpt-5 rate, if mini fell through
	});

	test("charges the generic gpt-5 rate for bare gpt-5", () => {
		const cents = priceCompletion("openai", "gpt-5", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// 1M*125c/1M + 1M*1000c/1M = 125+1000 = 1125c
		expect(cents).toBe(1125);
	});

	test("charges o4-mini at its own coded rate", () => {
		const cents = priceCompletion("openai", "o4-mini", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// 1M*110c/1M + 1M*440c/1M = 110+440 = 550c
		expect(cents).toBe(550);
	});

	test("charges o3-mini at its own coded rate, not the generic o3 rate", () => {
		const cents = priceCompletion("openai", "o3-mini", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		expect(cents).toBe(550);
		expect(cents).not.toBe(1000); // the generic o3 rate, if o3-mini fell through
	});

	test("charges the generic o3 rate for bare o3", () => {
		const cents = priceCompletion("openai", "o3", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimated: false,
		});
		// 1M*200c/1M + 1M*800c/1M = 200+800 = 1000c
		expect(cents).toBe(1000);
	});

	test("charges cohere command-r at flash-tier rates", () => {
		const cents = priceCompletion("cohere", "command-r-08-2024", {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			estimated: false,
		});
		// 1M * 15c + 100k * 60c/1M = 15 + 6 = 21c
		expect(cents).toBe(21);
	});

	test("charges cohere command-r-plus at premium-tier rates", () => {
		const cents = priceCompletion("cohere", "command-r-plus-08-2024", {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			estimated: false,
		});
		// 1M * 250c + 100k * 1000c/1M = 250 + 100 = 350c
		expect(cents).toBe(350);
	});
});

describe("cohere adapter", () => {
	test("sends preamble + message and Authorization header", async () => {
		mockFetch(
			new Response(
				JSON.stringify({
					text: "ack",
					meta: { tokens: { input_tokens: 12, output_tokens: 3 } },
				}),
				{ status: 200 },
			),
		);
		const adapter = createCohereAdapter({ apiKey: "co-key" });
		const res = await adapter.complete({
			systemPrompt: "Watcher",
			transcriptPrompt: "events",
			model: "command-r",
		});
		expect(res.text).toBe("ack");
		expect(res.usage.inputTokens).toBe(12);
		expect(res.usage.outputTokens).toBe(3);
		expect(res.usage.estimated).toBe(false);

		const [req] = capturedRequests;
		expect(req.url).toBe("https://api.cohere.com/v1/chat");
		expect((req.init.headers as Record<string, string>).Authorization).toBe("Bearer co-key");
		const body = JSON.parse(String(req.init.body));
		expect(body.model).toBe("command-r");
		expect(body.message).toBe("events");
		expect(body.preamble).toBe("Watcher");
		// Default sampling matches the watcher's policy.
		expect(body.temperature).toBe(0.2);
	});

	test("trims trailing slashes on baseUrl override", async () => {
		mockFetch(new Response(JSON.stringify({ text: "" }), { status: 200 }));
		const adapter = createCohereAdapter({
			apiKey: "co-key",
			baseUrl: "https://proxy.example.com//",
		});
		await adapter.complete({
			systemPrompt: "x",
			transcriptPrompt: "y",
			model: "command-r",
		});
		expect(capturedRequests[0].url).toBe("https://proxy.example.com/v1/chat");
	});

	test("normalizes 401 to permanent_auth and surfaces message field", async () => {
		mockFetch(new Response(JSON.stringify({ message: "invalid api token" }), { status: 401 }));
		const adapter = createCohereAdapter({ apiKey: "bad" });
		const err = await adapter
			.complete({ systemPrompt: "x", transcriptPrompt: "y", model: "command-r" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		const llm = err as LlmError;
		expect(llm.subType).toBe("permanent_auth");
		expect(llm.status).toBe(401);
		expect(llm.message).toContain("invalid api token");
	});

	test("normalizes 429 to transient_rate_limit", async () => {
		mockFetch(new Response(JSON.stringify({ message: "rate limit" }), { status: 429 }));
		const adapter = createCohereAdapter({ apiKey: "ok" });
		const err = await adapter
			.complete({ systemPrompt: "x", transcriptPrompt: "y", model: "command-r" })
			.catch((e: unknown) => e);
		expect((err as LlmError).subType).toBe("transient_rate_limit");
	});

	test("estimates tokens when meta.tokens is missing", async () => {
		mockFetch(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
		const adapter = createCohereAdapter({ apiKey: "ok" });
		const res = await adapter.complete({
			systemPrompt: "x",
			transcriptPrompt: "transcript body",
			model: "command-r",
		});
		expect(res.text).toBe("hello");
		expect(res.usage.estimated).toBe(true);
		expect(res.usage.inputTokens).toBeGreaterThan(0);
		expect(res.usage.outputTokens).toBeGreaterThan(0);
	});
});
