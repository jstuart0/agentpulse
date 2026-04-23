import {
	type LlmAdapter,
	LlmError,
	type LlmRequest,
	type LlmResponse,
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
					message?: { content?: string | null };
					finish_reason?: string;
				}>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
				};
			};

			const text = json.choices?.[0]?.message?.content ?? "";
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
	};
}
