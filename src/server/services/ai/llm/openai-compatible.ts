import {
	type LlmAdapter,
	LlmError,
	type LlmRequest,
	type LlmResponse,
	type LlmStreamEvent,
	type ProviderKind,
	classifyHttpError,
	estimateTokens,
} from "./types.js";

interface OpenAICompatibleParams {
	apiKey: string;
	baseUrl: string;
	/** Which `kind` this adapter claims. Defaults to "openai_compatible". */
	kind?: ProviderKind;
	/** Optional extra headers — OpenRouter wants HTTP-Referer / X-Title. */
	extraHeaders?: Record<string, string>;
}

/**
 * Adapter for any provider that speaks the OpenAI chat completions API at
 * `${baseUrl}/chat/completions`. Covers:
 * - OpenAI itself (baseUrl = https://api.openai.com/v1)
 * - OpenRouter (baseUrl = https://openrouter.ai/api/v1)
 * - Ollama (baseUrl = http://host:11434/v1, no real key needed)
 * - LM Studio (baseUrl = http://host:1234/v1)
 * - vLLM, llama.cpp server, etc.
 */
export function createOpenAICompatibleAdapter(params: OpenAICompatibleParams): LlmAdapter {
	const apiKey = params.apiKey;
	const baseUrl = params.baseUrl.replace(/\/+$/, "");
	const kind = params.kind ?? "openai_compatible";
	const extraHeaders = params.extraHeaders ?? {};

	return {
		kind,
		async complete(request: LlmRequest): Promise<LlmResponse> {
			const timeoutMs = request.timeoutMs ?? 60_000;
			const body = {
				model: request.model,
				temperature: request.temperature ?? 0.2,
				max_tokens: request.maxTokens ?? 1024,
				// response_format is OpenAI-only. We skip it since we want this
				// adapter to work with Ollama and other OpenAI-like servers
				// that don't implement structured output.
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.transcriptPrompt },
				],
				// Thinking-mode opt-outs. Qwen3 and similar reasoning models
				// consume the whole output window on CoT by default, leaving
				// `content` empty. These params disable that:
				//   - `think: false` — Ollama (≥0.7.0)
				//   - `chat_template_kwargs.enable_thinking: false` — vLLM / SGLang
				// Servers that don't recognize them ignore them harmlessly.
				think: false,
				chat_template_kwargs: { enable_thinking: false },
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey || "ollama"}`,
						...extraHeaders,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					throw new LlmError("transient_timeout", `${kind} request timed out`, undefined, err);
				}
				throw new LlmError("unknown", `${kind} request failed: ${err}`, undefined, err);
			}

			if (!response.ok) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				throw new LlmError(subType, `${kind} ${status}: ${errBody.slice(0, 300)}`, status);
			}

			const json = (await response.json()) as {
				choices?: Array<{
					message?: { content?: string | null; reasoning?: string | null };
					finish_reason?: string;
				}>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
				};
			};

			// Fall back to `reasoning` when `content` is empty. Some servers
			// (Ollama / vLLM serving Qwen3) return the thinking block as a
			// separate `reasoning` field and an empty `content` if the
			// answer itself didn't fit in the output budget. Better to
			// return the raw reasoning text than an empty string — the
			// caller can still mine comma-separated candidates out of it.
			const choice = json.choices?.[0]?.message;
			const text = choice?.content?.trim() ? choice.content : (choice?.reasoning ?? "");
			const usage = json.usage ?? {};

			return {
				text,
				usage: {
					inputTokens:
						usage.prompt_tokens ?? estimateTokens(request.systemPrompt + request.transcriptPrompt),
					outputTokens: usage.completion_tokens ?? estimateTokens(text),
					estimated: usage.prompt_tokens === undefined,
				},
				rawResponse: json,
			};
		},
		async *completeStream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
			const timeoutMs = request.timeoutMs ?? 60_000;
			const body = {
				model: request.model,
				temperature: request.temperature ?? 0.2,
				max_tokens: request.maxTokens ?? 1024,
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.transcriptPrompt },
				],
				stream: true,
				// Ollama + OpenAI both support usage in the final SSE chunk
				// when stream_options.include_usage = true. Harmless on the
				// servers that ignore the option.
				stream_options: { include_usage: true },
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey || "ollama"}`,
						Accept: "text/event-stream",
						...extraHeaders,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					throw new LlmError("transient_timeout", `${kind} stream timed out`, undefined, err);
				}
				throw new LlmError("unknown", `${kind} stream failed: ${err}`, undefined, err);
			}

			if (!response.ok || !response.body) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				throw new LlmError(subType, `${kind} stream ${status}: ${errBody.slice(0, 300)}`, status);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let fullText = "";
			let promptTokens: number | undefined;
			let completionTokens: number | undefined;
			let finalRaw: unknown = null;

			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// SSE frames are separated by blank lines. Keep any partial
					// frame in the buffer until we see its terminator.
					let sepIdx = buffer.indexOf("\n\n");
					while (sepIdx !== -1) {
						const frame = buffer.slice(0, sepIdx);
						buffer = buffer.slice(sepIdx + 2);
						sepIdx = buffer.indexOf("\n\n");
						for (const rawLine of frame.split("\n")) {
							const line = rawLine.trim();
							if (!line.startsWith("data:")) continue;
							const payload = line.slice(5).trim();
							if (!payload || payload === "[DONE]") continue;
							let parsed: {
								choices?: Array<{
									delta?: { content?: string | null };
									finish_reason?: string | null;
								}>;
								usage?: { prompt_tokens?: number; completion_tokens?: number };
							};
							try {
								parsed = JSON.parse(payload);
							} catch {
								// Servers occasionally emit a keep-alive / comment; skip.
								continue;
							}
							finalRaw = parsed;
							const delta = parsed.choices?.[0]?.delta?.content;
							if (typeof delta === "string" && delta.length > 0) {
								fullText += delta;
								yield { kind: "delta", text: delta };
							}
							if (parsed.usage) {
								promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
								completionTokens = parsed.usage.completion_tokens ?? completionTokens;
							}
						}
					}
				}
			} finally {
				try {
					reader.releaseLock();
				} catch {
					// Reader already released — ignore.
				}
			}

			yield {
				kind: "done",
				response: {
					text: fullText,
					usage: {
						inputTokens:
							promptTokens ?? estimateTokens(request.systemPrompt + request.transcriptPrompt),
						outputTokens: completionTokens ?? estimateTokens(fullText),
						estimated: promptTokens === undefined,
					},
					rawResponse: finalRaw,
				},
			};
		},
	};
}
