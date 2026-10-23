import { llmFetch, readJsonCapped, readStreamCapped } from "../http.js";
import {
	type LlmAdapter,
	LlmError,
	type LlmRequest,
	type LlmResponse,
	type LlmStreamEvent,
	type ProviderKind,
	classifyHttpError,
	estimateTokens,
	mapStopReason,
} from "./types.js";

const OPENAI_STOP_REASONS = { stop: "end", length: "length", content_filter: "refusal" } as const;

interface OpenAICompatibleParams {
	apiKey: string;
	baseUrl: string;
	/** Which `kind` this adapter claims. Defaults to "openai_compatible". */
	kind?: ProviderKind;
	/** Optional extra headers — OpenRouter wants HTTP-Referer / X-Title. */
	extraHeaders?: Record<string, string>;
}

/**
 * The chat-completions body shared by `complete` and `completeStream`.
 *
 * Thinking-mode opt-outs. Qwen3 and similar reasoning models spend the whole
 * output window on chain of thought by default and leave `content` empty.
 * Three flags exist and servers honour different ones, so all are sent:
 *   - `think: false`: Ollama-native /api/chat (NOT honoured on /v1)
 *   - `chat_template_kwargs.enable_thinking: false`: vLLM / SGLang style servers
 *   - `reasoning_effort: "none"`: the OpenAI-spec parameter, and the only one
 *     Ollama's /v1 endpoint honours. Sent only when the caller asks for it
 *     (`disableReasoning`), so a call that wants the model's own default is
 *     not changed. Every call that produces an answer or a JSON decision sets it.
 */
function buildRequestBody(request: LlmRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
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
		think: false,
		chat_template_kwargs: { enable_thinking: false },
	};
	if (request.disableReasoning) body.reasoning_effort = "none";
	return body;
}

/**
 * A reply with no answer text. Saying why matters to whoever reads the log:
 * a `length` stop means the model ran out of `max_tokens` (usually while
 * thinking), which the caller fixes with `disableReasoning` or a larger
 * budget, not by retrying the same call.
 */
function emptyOutputError(
	kind: string,
	finishReason: string | null | undefined,
	hadReasoning: boolean,
): LlmError {
	const why =
		finishReason === "length"
			? hadReasoning
				? "ran out of output tokens while reasoning"
				: "ran out of output tokens"
			: hadReasoning
				? "returned only reasoning"
				: "returned nothing";
	return new LlmError(
		"empty_output",
		`${kind} returned no answer text (the model ${why}; finish_reason=${finishReason ?? "none"})`,
	);
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
			const body = buildRequestBody(request);

			const response = await llmFetch(
				`${baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey || "ollama"}`,
						...extraHeaders,
					},
					body: JSON.stringify(body),
				},
				{ timeoutMs, signal: request.signal, label: `${kind} request` },
			);

			if (!response.ok) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				throw new LlmError(subType, `${kind} ${status}: ${errBody.slice(0, 300)}`, status);
			}

			const json = (await readJsonCapped(response)) as {
				choices?: Array<{
					message?: { content?: string | null; reasoning?: string | null };
					finish_reason?: string | null;
				}>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
				};
			};

			// `reasoning` is never an answer. A reasoning model that runs out of
			// output budget mid-thought returns an empty `content` and its chain
			// of thought here; passing that on as the reply shows the user a
			// truncated monologue as if it were the answer. A refusal is the one
			// empty reply the caller handles itself, by its stop reason.
			const choice = json.choices?.[0]?.message;
			const text = choice?.content ?? "";
			const stopReason = mapStopReason(json.choices?.[0]?.finish_reason, OPENAI_STOP_REASONS);
			if (!text.trim() && stopReason !== "refusal") {
				throw emptyOutputError(kind, json.choices?.[0]?.finish_reason, Boolean(choice?.reasoning));
			}
			const usage = json.usage ?? {};

			return {
				text,
				stopReason,
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
				...buildRequestBody(request),
				stream: true,
				// Ollama + OpenAI both support usage in the final SSE chunk
				// when stream_options.include_usage = true. Harmless on the
				// servers that ignore the option.
				stream_options: { include_usage: true },
			};

			const response = await llmFetch(
				`${baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey || "ollama"}`,
						Accept: "text/event-stream",
						...extraHeaders,
					},
					body: JSON.stringify(body),
				},
				{ timeoutMs, signal: request.signal, label: `${kind} stream` },
			);

			if (!response.ok || !response.body) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				throw new LlmError(subType, `${kind} stream ${status}: ${errBody.slice(0, 300)}`, status);
			}

			const decoder = new TextDecoder();
			let buffer = "";
			let fullText = "";
			let promptTokens: number | undefined;
			let completionTokens: number | undefined;
			let finalRaw: unknown = null;
			let finishReason: string | null | undefined;
			let sawReasoning = false;
			for await (const value of readStreamCapped(response)) {
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
								delta?: { content?: string | null; reasoning?: string | null };
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
						finishReason = parsed.choices?.[0]?.finish_reason ?? finishReason;
						if (parsed.choices?.[0]?.delta?.reasoning) sawReasoning = true;
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

			const stopReason = mapStopReason(finishReason, OPENAI_STOP_REASONS);
			if (!fullText.trim() && stopReason !== "refusal") {
				throw emptyOutputError(kind, finishReason, sawReasoning);
			}
			yield {
				kind: "done",
				response: {
					text: fullText,
					stopReason,
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
