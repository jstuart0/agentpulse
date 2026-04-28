import {
	type LlmAdapter,
	LlmError,
	type LlmRequest,
	type LlmResponse,
	classifyHttpError,
	estimateTokens,
} from "./types.js";

interface CohereRequestParams {
	apiKey: string;
	baseUrl?: string;
}

/**
 * Cohere Chat API adapter (command-r, command-r-plus).
 *
 * Cohere's wire format differs from the OpenAI chat completions surface:
 *   - Request:  { message, preamble, chat_history? }
 *   - Response: { text, meta: { tokens: { input_tokens, output_tokens } } }
 *   - Error:    { message: "..." }   (no nested error object)
 *
 * The watcher uses one system + one user message per turn, so we map
 * `systemPrompt` -> `preamble` and `transcriptPrompt` -> `message`.
 * `chat_history` is omitted because the watcher always sends a fresh
 * transcript excerpt; multi-turn conversation history is the caller's
 * responsibility.
 */
export function createCohereAdapter(params: CohereRequestParams): LlmAdapter {
	const apiKey = params.apiKey;
	const baseUrl = params.baseUrl?.replace(/\/+$/, "") || "https://api.cohere.com";

	return {
		kind: "cohere",
		async complete(request: LlmRequest): Promise<LlmResponse> {
			const timeoutMs = request.timeoutMs ?? 60_000;
			const body: Record<string, unknown> = {
				model: request.model,
				message: request.transcriptPrompt,
				preamble: request.systemPrompt,
				max_tokens: request.maxTokens ?? 1024,
				temperature: request.temperature ?? 0.2,
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/chat`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					throw new LlmError("transient_timeout", "Cohere request timed out", undefined, err);
				}
				throw new LlmError("unknown", `Cohere request failed: ${err}`, undefined, err);
			}

			if (!response.ok) {
				const { subType, body: errBody, status } = await classifyHttpError(response);
				const message = extractCohereErrorMessage(errBody) ?? errBody.slice(0, 300);
				throw new LlmError(subType, `Cohere ${status}: ${message}`, status);
			}

			const json = (await response.json()) as {
				text?: string;
				meta?: {
					tokens?: {
						input_tokens?: number;
						output_tokens?: number;
					};
				};
			};

			const text = json.text ?? "";
			const tokens = json.meta?.tokens ?? {};
			const inputReported = typeof tokens.input_tokens === "number";
			return {
				text,
				usage: {
					inputTokens: tokens.input_tokens ?? estimateTokens(request.transcriptPrompt),
					outputTokens: tokens.output_tokens ?? estimateTokens(text),
					estimated: !inputReported,
				},
				rawResponse: json,
			};
		},
	};
}

function extractCohereErrorMessage(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		if (typeof parsed.message === "string" && parsed.message.length > 0) {
			return parsed.message.slice(0, 300);
		}
	} catch {
		// fall through
	}
	return null;
}
