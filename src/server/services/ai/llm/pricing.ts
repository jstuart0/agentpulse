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
	// Anthropic — the claude-*-5 patterns must precede the claude-*-4 patterns
	// below: those patterns' `[^-]*` suffix isn't end-anchored, so
	// `/^claude-haiku-4[^-]*/` prefix-matches "claude-haiku-4-5" too. Listing
	// the dotted-5-successor patterns first is load-bearing, not stylistic.
	{
		// Sonnet 4.5 list price carried forward (Decision 2, 2026-07-17) —
		// verify against the official Sonnet 5 pricing page when published.
		match: /^claude-sonnet-5/,
		rate: { inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30 },
	},
	{
		// UNVERIFIED — conservative opus-class assumption, 2026-07-17
		// (Decision 2: no published claude-fable-5 pricing found at
		// implementation time; overcounting is the safe failure mode here).
		match: /^claude-fable-5/,
		rate: { inputPer1M: 1500, outputPer1M: 7500, cacheReadPer1M: 150 },
	},
	{
		// Must precede claude-haiku-4[^-]* below — see the ordering note above.
		match: /^claude-haiku-4-5/,
		rate: { inputPer1M: 100, outputPer1M: 500, cacheReadPer1M: 10 },
	},
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
	// OpenAI — most-specific-first: /^gpt-5/ and /^o3/ below aren't
	// end-anchored either, so the -nano/-mini/-mini variants must precede
	// their generic parent pattern (same ordering hazard as Anthropic above).
	{
		match: /^gpt-5-nano/,
		rate: { inputPer1M: 5, outputPer1M: 40, cacheReadPer1M: 1 },
	},
	{
		match: /^gpt-5-mini/,
		rate: { inputPer1M: 25, outputPer1M: 200, cacheReadPer1M: 3 },
	},
	{
		// Also covers gpt-5-codex / dated gpt-5.x variants.
		match: /^gpt-5/,
		rate: { inputPer1M: 125, outputPer1M: 1000, cacheReadPer1M: 13 },
	},
	{
		match: /^o4-mini/,
		rate: { inputPer1M: 110, outputPer1M: 440, cacheReadPer1M: 11 },
	},
	{
		// Must precede /^o3/ below — same ordering hazard as gpt-5-nano/-mini.
		match: /^o3-mini/,
		rate: { inputPer1M: 110, outputPer1M: 440, cacheReadPer1M: 11 },
	},
	{
		match: /^o3/,
		rate: { inputPer1M: 200, outputPer1M: 800, cacheReadPer1M: 20 },
	},
	{ match: /^gpt-4o-mini/, rate: { inputPer1M: 15, outputPer1M: 60 } },
	{ match: /^gpt-4o/, rate: { inputPer1M: 250, outputPer1M: 1000 } },
	{ match: /^gpt-4\.1/, rate: { inputPer1M: 200, outputPer1M: 800 } },
	// Google
	{ match: /^gemini-1\.5-flash/, rate: { inputPer1M: 8, outputPer1M: 30 } },
	{ match: /^gemini-1\.5-pro/, rate: { inputPer1M: 125, outputPer1M: 500 } },
	{ match: /^gemini-2/, rate: { inputPer1M: 100, outputPer1M: 400 } },
	// Cohere
	{ match: /^command-r-plus/, rate: { inputPer1M: 250, outputPer1M: 1000 } },
	{ match: /^command-r/, rate: { inputPer1M: 15, outputPer1M: 60 } },
];

/** Local/self-hosted kinds assumed free. */
const FREE_KINDS: readonly ProviderKind[] = ["openai_compatible"] as const;

// Decision 1: an unknown model in 2026 is far more likely sonnet-class than
// gpt-4o-mini-class. Raised from the original 50c/200c estimate (with no
// cache-read price at all) so unmatched models can't silently under-trip
// the daily spend cap — same "err on the side of spend slightly more"
// philosophy as the rounding below.
const FALLBACK_RATE: ModelRate = { inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30 };

// Log-once per unmatched model name so fallback pricing is visible without
// spamming logs on every completion. Module-level and independent of any
// other log-once set in the codebase (e.g. the normalizer's unknown-event
// set) — deliberately not shared via a helper.
const warnedFallbackModels = new Set<string>();

/**
 * Compute cents charged for a completion. Returns 0 for local models.
 * When the model isn't in the rate table, uses the Decision 1 fallback rate
 * (see FALLBACK_RATE) so the cap math still engages, and logs once per
 * distinct unmatched model name.
 */
export function priceCompletion(kind: ProviderKind, model: string, usage: LlmUsage): number {
	if (FREE_KINDS.includes(kind)) return 0;

	const matched = MODEL_RATES.find((r) => r.match.test(model))?.rate;
	if (!matched && !warnedFallbackModels.has(model)) {
		warnedFallbackModels.add(model);
		console.warn(JSON.stringify({ kind: "pricing_fallback_used", model }));
	}
	const rate = matched ?? FALLBACK_RATE;

	// Floor at zero: malformed usage (cacheReadTokens reported greater than
	// inputTokens) must not discount the call below the cache-read-alone cost.
	const inputTokens = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0));
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
