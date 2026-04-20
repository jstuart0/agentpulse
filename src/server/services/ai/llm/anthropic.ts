import {
	classifyHttpError,
	estimateTokens,
	LlmError,
	type LlmAdapter,
	type LlmRequest,
	type LlmResponse,
} from "./types.js";

interface AnthropicRequestParams {
	apiKey: string;
	baseUrl?: string;
	/** Default "2023-06-01" — unchanged since Messages API GA. */
	apiVersion?: string;
}

export function createAnthropicAdapter(params: AnthropicRequestParams): LlmAdapter {
	const apiKey = params.apiKey;
	const baseUrl = params.baseUrl?.replace(/\/+$/, "") || "https://api.anthropic.com";
	const apiVersion = params.apiVersion || "2023-06-01";

	return {
		kind: "anthropic",
		async complete(request: LlmRequest): Promise<LlmResponse> {
			const timeoutMs = request.timeoutMs ?? 60_000;
			const body = {
				model: request.model,
				max_tokens: request.maxTokens ?? 1024,
				temperature: request.temperature ?? 0.2,
				system: [
					{
						type: "text",
						text: request.systemPrompt,
						// Prompt caching: the stable system prompt is cached, so
						// subsequent turns in the same session reuse it for free.
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [
					{
						role: "user",
						content: request.transcriptPrompt,
					},
				],
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": apiVersion,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					throw new LlmError("transient_timeout", "Anthropic request timed out", undefined, err);
				}
				throw new LlmError("unknown", `Anthropic request failed: ${err}`, undefined, err);
			}

			if (!response.ok) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				throw new LlmError(
					subType,
					`Anthropic ${status}: ${errBody.slice(0, 300)}`,
					status,
				);
			}

			const json = (await response.json()) as {
				content?: Array<{ type: string; text?: string }>;
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					cache_creation_input_tokens?: number;
					cache_read_input_tokens?: number;
				};
			};

			const text = (json.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");

			const usage = json.usage ?? {};
			return {
				text,
				usage: {
					inputTokens: usage.input_tokens ?? estimateTokens(request.transcriptPrompt),
					outputTokens: usage.output_tokens ?? estimateTokens(text),
					cacheReadTokens: usage.cache_read_input_tokens,
					cacheWriteTokens: usage.cache_creation_input_tokens,
					estimated: usage.input_tokens === undefined,
				},
				rawResponse: json,
			};
		},
	};
}
