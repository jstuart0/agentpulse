/**
 * Shared types across LLM provider adapters.
 *
 * The adapter surface is deliberately minimal: give me a system prompt,
 * a dynamic transcript, and a model; return text plus usage.
 * Anything provider-specific (prompt caching, streaming chunks, tool
 * use) stays inside the adapter.
 */

export type ProviderKind =
	| "anthropic"
	| "openai"
	| "google"
	| "openrouter"
	| "openai_compatible"
	| "cohere";

export interface LlmRequest {
	/** Stable across a session — candidate for provider prompt caching. */
	systemPrompt: string;
	/** Dynamic per-turn body: transcript excerpt, trigger metadata, schema. */
	transcriptPrompt: string;
	/** Model identifier as the provider expects it. */
	model: string;
	/** Max tokens to generate. Default 1024 — enough for a JSON decision. */
	maxTokens?: number;
	/** Sampling temperature. Default 0.2 — watcher wants stable output. */
	temperature?: number;
	/** Optional request timeout override (ms). Default 60s. */
	timeoutMs?: number;
	/** When true, hint the provider to skip any reasoning/thinking phase
	 *  (used for JSON-only classifier calls on local models like qwen3).
	 *  Adapter-specific: openai-compatible sets `reasoning_effort: "none"`. */
	disableReasoning?: boolean;
}

export interface LlmUsage {
	inputTokens: number;
	outputTokens: number;
	/** Only populated by providers that report cache metrics. */
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** True when tokens were estimated from character count, not reported. */
	estimated: boolean;
}

export interface LlmResponse {
	/** Raw text content returned by the model. */
	text: string;
	usage: LlmUsage;
	/** Full provider response — kept for debugging / audit trail. */
	rawResponse: unknown;
}

export type LlmErrorSubType =
	| "transient_rate_limit"
	| "transient_timeout"
	| "permanent_auth"
	| "permanent_validation"
	| "unknown";

export class LlmError extends Error {
	constructor(
		readonly subType: LlmErrorSubType,
		message: string,
		readonly status?: number,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "LlmError";
	}
}

/** Result of an error-normalization attempt against a fetch Response. */
export async function classifyHttpError(
	response: Response,
): Promise<{ subType: LlmErrorSubType; body: string; status: number }> {
	const body = await response.text().catch(() => "");
	const status = response.status;
	if (status === 401 || status === 403) {
		return { subType: "permanent_auth", body, status };
	}
	if (status === 400 || status === 404 || status === 422) {
		return { subType: "permanent_validation", body, status };
	}
	if (status === 408 || status === 429) {
		return { subType: "transient_rate_limit", body, status };
	}
	if (status >= 500) {
		return { subType: "transient_timeout", body, status };
	}
	return { subType: "unknown", body, status };
}

/**
 * One event from a streaming completion. Adapters emit zero or more
 * `delta` events followed by exactly one `done` event. Errors are
 * surfaced by throwing from the iterator, same as `complete`.
 */
export type LlmStreamEvent =
	| { kind: "delta"; text: string }
	| { kind: "done"; response: LlmResponse };

export interface LlmAdapter {
	readonly kind: ProviderKind;
	complete(request: LlmRequest): Promise<LlmResponse>;
	/**
	 * Optional streaming API. Adapters that don't implement this can be
	 * wrapped by a fallback that calls `complete` and emits the full text
	 * as a single delta (see `streamWithFallback` in this module).
	 */
	completeStream?(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

/**
 * Wrap an adapter so callers can always iterate. For providers that
 * don't implement real streaming we just call `complete` and emit one
 * big delta — the caller code path stays identical.
 */
export async function* streamWithFallback(
	adapter: LlmAdapter,
	request: LlmRequest,
): AsyncIterable<LlmStreamEvent> {
	if (adapter.completeStream) {
		for await (const evt of adapter.completeStream(request)) yield evt;
		return;
	}
	const response = await adapter.complete(request);
	if (response.text) yield { kind: "delta", text: response.text };
	yield { kind: "done", response };
}

/** Conservative character-based estimate used when providers don't report usage. */
export function estimateTokens(text: string): number {
	// GPT family averages ~4 chars/token; 4.5 leaves a buffer for code.
	return Math.max(1, Math.ceil(text.length / 4.5));
}
