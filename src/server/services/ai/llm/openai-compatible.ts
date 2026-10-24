import { llmFetch, readJsonCapped, readStreamCapped } from "../http.js";
import {
	type LlmAdapter,
	LlmError,
	type LlmRequest,
	type LlmResponse,
	type LlmStopReason,
	type LlmStreamEvent,
	type LlmUsage,
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
 * Servers honour different flags, and a hosted API may reject one it does not
 * know, so which are sent depends on the provider kind:
 *   - `think: false` (Ollama-native /api/chat, NOT honoured on /v1) and
 *     `chat_template_kwargs.enable_thinking: false` (vLLM / SGLang style) are
 *     sent only to `openai_compatible`, the kind for self-hosted servers.
 *     OpenAI, Google and OpenRouter get neither.
 *   - `reasoning_effort: "none"` is sent, when the caller asks for it
 *     (`disableReasoning`), to `openai_compatible` (the only flag Ollama's /v1
 *     honours) and `openrouter` (which ignores what an upstream model does not
 *     take; checked against one non-reasoning model).
 *   - `openai` gets `reasoning_effort` only for its reasoning model families,
 *     with the lowest value each accepts (see `openAiLowestEffort`), and nothing
 *     for other models, which have no use for it. `google` gets nothing: some
 *     models there cannot turn thinking off. A reasoning model that spends its
 *     budget thinking anyway now ends in an `empty_output` error, not a bad answer.
 */
/**
 * The lowest `reasoning_effort` an OpenAI model accepts, or null for a model
 * that does not reason. From OpenAI's documentation, not verified against the
 * API: gpt-5.1 and later accept "none"; gpt-5, gpt-5-mini and gpt-5-nano
 * accept "minimal" but not "none"; the o-series accepts "low" as its lowest.
 */
export function openAiLowestEffort(model: string): "none" | "minimal" | "low" | null {
	if (/^gpt-5\.\d/.test(model)) return "none";
	if (/^gpt-5/.test(model)) return "minimal";
	if (/^o\d/.test(model)) return "low";
	return null;
}

const THINKING_FLAGS_KINDS: ReadonlySet<ProviderKind> = new Set(["openai_compatible"]);
const REASONING_EFFORT_KINDS: ReadonlySet<ProviderKind> = new Set([
	"openai_compatible",
	"openrouter",
]);

function buildRequestBody(request: LlmRequest, kind: ProviderKind): Record<string, unknown> {
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
	};
	if (THINKING_FLAGS_KINDS.has(kind)) {
		body.think = false;
		body.chat_template_kwargs = { enable_thinking: false };
	}
	if (request.disableReasoning) {
		if (REASONING_EFFORT_KINDS.has(kind)) {
			body.reasoning_effort = "none";
		} else if (kind === "openai") {
			const effort = openAiLowestEffort(request.model);
			if (effort) body.reasoning_effort = effort;
		}
	}
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
	usage: LlmUsage,
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
		undefined,
		undefined,
		false,
		usage,
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
			const body = buildRequestBody(request, kind);

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
					message?: {
						content?: string | null;
						reasoning?: string | null;
						refusal?: string | null;
					};
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
			// empty reply the caller handles itself: it arrives as a
			// `content_filter` stop or in `message.refusal` with null content.
			const choice = json.choices?.[0]?.message;
			const content = choice?.content ?? "";
			const refusal = choice?.refusal?.trim() ? choice.refusal : "";
			const text = content.trim() ? content : refusal;
			const usage = json.usage ?? {};
			const reported: LlmUsage = {
				inputTokens:
					usage.prompt_tokens ?? estimateTokens(request.systemPrompt + request.transcriptPrompt),
				outputTokens: usage.completion_tokens ?? estimateTokens(text),
				estimated: usage.prompt_tokens === undefined,
			};
			const stopReason: LlmStopReason = content.trim()
				? mapStopReason(json.choices?.[0]?.finish_reason, OPENAI_STOP_REASONS)
				: refusal
					? "refusal"
					: mapStopReason(json.choices?.[0]?.finish_reason, OPENAI_STOP_REASONS);
			if (!text.trim() && stopReason !== "refusal") {
				throw emptyOutputError(
					kind,
					json.choices?.[0]?.finish_reason,
					Boolean(choice?.reasoning),
					reported,
				);
			}

			return {
				text,
				stopReason,
				usage: reported,
				rawResponse: json,
			};
		},
		async *completeStream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
			const timeoutMs = request.timeoutMs ?? 60_000;
			const body = {
				...buildRequestBody(request, kind),
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
			let refusalText = "";
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
								delta?: {
									content?: string | null;
									reasoning?: string | null;
									refusal?: string | null;
								};
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
						const refusalDelta = parsed.choices?.[0]?.delta?.refusal;
						if (typeof refusalDelta === "string") refusalText += refusalDelta;
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

			const answer = fullText.trim() ? fullText : refusalText;
			const streamUsage: LlmUsage = {
				inputTokens:
					promptTokens ?? estimateTokens(request.systemPrompt + request.transcriptPrompt),
				outputTokens: completionTokens ?? estimateTokens(answer),
				estimated: promptTokens === undefined,
			};
			const stopReason: LlmStopReason =
				!fullText.trim() && refusalText.trim()
					? "refusal"
					: mapStopReason(finishReason, OPENAI_STOP_REASONS);
			if (!answer.trim() && stopReason !== "refusal") {
				throw emptyOutputError(kind, finishReason, sawReasoning, streamUsage);
			}
			yield {
				kind: "done",
				response: {
					text: answer,
					stopReason,
					usage: streamUsage,
					rawResponse: finalRaw,
				},
			};
		},
	};
}
