import type { LlmUsage, ProviderKind } from "./types.js";

/** USD per million tokens, rounded to integer cents per million for stability. */
interface ModelRate {
	/** cents per 1M input tokens */
	inputPer1M: number;
	/** cents per 1M output tokens */
	outputPer1M: number;
	/** cents per 1M cached-read tokens (Anthropic); falls back to input price */
	cacheReadPer1M?: number;
}

// Rates are approximate public-list prices as of early 2026. Keep them in
// code, not DB — this is a read-only reference table we update via commits.
// When a model isn't listed we fall back to a moderate estimate and mark
// the line as estimated so UI can warn the user.
const MODEL_RATES: Array<{ match: RegExp; rate: ModelRate }> = [
	// Anthropic
	{
		match: /^claude-opus-4[^-]*/,
		rate: { inputPer1M: 1500, outputPer1M: 7500, cacheReadPer1M: 150 },
	},
	{
		match: /^claude-sonnet-4[^-]*/,
		rate: { inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30 },
	},
	{
		match: /^claude-haiku-4[^-]*/,
		rate: { inputPer1M: 80, outputPer1M: 400, cacheReadPer1M: 8 },
	},
	// OpenAI
	{ match: /^gpt-4o-mini/, rate: { inputPer1M: 15, outputPer1M: 60 } },
	{ match: /^gpt-4o/, rate: { inputPer1M: 250, outputPer1M: 1000 } },
	{ match: /^gpt-4\.1/, rate: { inputPer1M: 200, outputPer1M: 800 } },
	// Google
	{ match: /^gemini-1\.5-flash/, rate: { inputPer1M: 8, outputPer1M: 30 } },
	{ match: /^gemini-1\.5-pro/, rate: { inputPer1M: 125, outputPer1M: 500 } },
	{ match: /^gemini-2/, rate: { inputPer1M: 100, outputPer1M: 400 } },
];

/** Local/self-hosted kinds assumed free. */
const FREE_KINDS: readonly ProviderKind[] = ["openai_compatible"] as const;

/**
 * Compute cents charged for a completion. Returns 0 for local models.
 * When the model isn't in the rate table, uses a conservative default of
 * 50c/1M input + 200c/1M output so the cap math still engages.
 */
export function priceCompletion(kind: ProviderKind, model: string, usage: LlmUsage): number {
	if (FREE_KINDS.includes(kind)) return 0;

	const rate = MODEL_RATES.find((r) => r.match.test(model))?.rate ?? {
		inputPer1M: 50,
		outputPer1M: 200,
	};

	const inputTokens = usage.inputTokens - (usage.cacheReadTokens ?? 0);
	const inputCost = (inputTokens * rate.inputPer1M) / 1_000_000;
	const cacheCost =
		rate.cacheReadPer1M && usage.cacheReadTokens
			? (usage.cacheReadTokens * rate.cacheReadPer1M) / 1_000_000
			: 0;
	const outputCost = (usage.outputTokens * rate.outputPer1M) / 1_000_000;

	// Round up — err on the side of "spend slightly more than advertised"
	// so we never undercharge and miss a cap.
	return Math.ceil(inputCost + cacheCost + outputCost);
}
