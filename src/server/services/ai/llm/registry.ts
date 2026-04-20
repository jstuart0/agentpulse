import type { LlmAdapter, ProviderKind } from "./types.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";

export interface ProviderConfig {
	kind: ProviderKind;
	apiKey: string;
	baseUrl?: string;
}

/** Default base URL per provider kind, if the row doesn't override. */
function defaultBaseUrl(kind: ProviderKind): string {
	switch (kind) {
		case "anthropic":
			return "https://api.anthropic.com";
		case "openai":
			return "https://api.openai.com/v1";
		case "openrouter":
			return "https://openrouter.ai/api/v1";
		case "google":
			// Gemini exposes an OpenAI-compatible endpoint at /openai/.
			return "https://generativelanguage.googleapis.com/v1beta/openai";
		case "openai_compatible":
			return "http://localhost:11434/v1"; // Ollama default
	}
}

export function getAdapter(provider: ProviderConfig): LlmAdapter {
	const baseUrl = provider.baseUrl?.trim() || defaultBaseUrl(provider.kind);

	if (provider.kind === "anthropic") {
		return createAnthropicAdapter({ apiKey: provider.apiKey, baseUrl });
	}

	// Everything else uses the OpenAI-compatible chat completions surface.
	// OpenRouter wants attribution headers; include them when applicable so
	// the request appears cleanly in OpenRouter's dashboards.
	const extraHeaders =
		provider.kind === "openrouter"
			? {
					"HTTP-Referer": "https://github.com/jstuart0/agentpulse",
					"X-Title": "AgentPulse",
				}
			: undefined;

	return createOpenAICompatibleAdapter({
		apiKey: provider.apiKey,
		baseUrl,
		kind: provider.kind,
		extraHeaders,
	});
}
