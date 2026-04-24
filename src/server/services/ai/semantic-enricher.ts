/**
 * Semantic enrichment contract for the Ask resolver.
 *
 * The lexical FTS path alone only finds sessions whose events contain
 * the literal words the user typed. Real questions like "find the
 * session where I wrestled with tightly coupled code" want meaning
 * matching — synonyms, related concepts, genuinely paraphrased content.
 *
 * Today we ship a single implementation (`LlmQueryExpander`) that uses
 * the default LLM to expand the query into related search terms which
 * the resolver then ORs into the FTS query. Tomorrow a
 * `VectorEmbeddingEnricher` (issue #TBD) will populate `directHits`
 * with cosine-similarity results from sqlite-vss / pgvector. Both plug
 * into the same resolver seam so the integration point doesn't churn.
 */

import { isAiActive } from "./feature.js";
import { getAdapter } from "./llm/registry.js";
import type { LlmAdapter } from "./llm/types.js";
import { getDefaultProvider, getProvider, getProviderApiKey } from "./providers-service.js";

export interface EnrichmentResult {
	/**
	 * Additional terms the resolver should OR into its lexical FTS query.
	 * LLM expansion populates this with synonyms/related jargon; a pure
	 * vector enricher would leave it empty.
	 */
	extraTerms: string[];
	/**
	 * Direct sessionId → score hits, bypassing the lexical index entirely.
	 * Vector backends will populate this; LLM expansion leaves it empty
	 * and relies on the FTS join to surface the actual rows.
	 */
	directHits: Map<string, number>;
}

export interface SemanticEnricher {
	readonly name: "llm-expansion" | "vector-embedding";
	enrich(query: string): Promise<EnrichmentResult>;
}

/** An empty result is always valid — callers can substitute it freely. */
export const EMPTY_ENRICHMENT: EnrichmentResult = {
	extraTerms: [],
	directHits: new Map(),
};

/**
 * LLM-driven query expansion. Given a user question, asks the default
 * LLM to emit ~5-10 comma-separated search terms covering synonyms and
 * related concepts. Fails closed — if the provider is unavailable, the
 * model mis-formats, or the call times out, we return empty and the
 * caller falls back to lexical-only search.
 */
export class LlmQueryExpander implements SemanticEnricher {
	readonly name = "llm-expansion" as const;

	constructor(
		private readonly adapter: LlmAdapter,
		private readonly model: string,
	) {}

	async enrich(query: string): Promise<EnrichmentResult> {
		const trimmed = query.trim();
		if (!trimmed) return EMPTY_ENRICHMENT;
		try {
			const res = await this.adapter.complete({
				systemPrompt: SYSTEM_PROMPT,
				transcriptPrompt: `Question: ${trimmed}\nTerms:`,
				model: this.model,
				maxTokens: 120,
				// Low but non-zero: we want some variation in synonym choice
				// without the model going off the rails.
				temperature: 0.3,
				timeoutMs: 8000,
			});
			const extraTerms = parseExpansion(res.text);
			return { extraTerms, directHits: new Map() };
		} catch {
			return EMPTY_ENRICHMENT;
		}
	}
}

const SYSTEM_PROMPT =
	"You help a full-text search find relevant past conversations. " +
	"Given a user's question, output 5 to 10 comma-separated search terms. " +
	"Include synonyms, related jargon, and concept aliases a developer might " +
	"have used when talking about the topic. Each term is one to three words, " +
	"lowercase, no punctuation. Output ONLY the comma-separated list — no " +
	"preamble, no numbering, no explanation.";

/**
 * Parse the model's comma-separated output into a bounded, de-duplicated
 * list of search terms. Defensive against:
 *   - Chatty preamble ("Sure! Here are the terms: …")
 *   - Bulleted / numbered output
 *   - Terms with quotes or parenthetical asides
 */
export function parseExpansion(text: string): string[] {
	const body = text
		// Strip anything before a likely list start: a word followed by comma
		// or the first ":" / "-" if it appears in the preamble.
		.replace(/^[\s\S]*?:\s*/, "")
		.trim();
	const parts = body
		.split(/[\n,]+/)
		.map((s) =>
			s
				.toLowerCase()
				.replace(/^\s*[-*•\d.)]+\s*/, "") // strip bullet/number prefixes
				.replace(/["'`]/g, "")
				.replace(/\(.*?\)/g, "")
				.trim(),
		)
		.filter((t) => t.length >= 2 && t.length <= 40 && !/^(and|or|the)$/.test(t));
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const p of parts) {
		if (seen.has(p)) continue;
		seen.add(p);
		deduped.push(p);
		if (deduped.length >= 15) break;
	}
	return deduped;
}

/**
 * Factory. Returns `null` when AI isn't compiled in, runtime-enabled,
 * or when no default provider is configured — lets callers cleanly
 * fall back to lexical-only search without having to check those
 * conditions themselves.
 */
export async function getSemanticEnricher(): Promise<SemanticEnricher | null> {
	if (!(await isAiActive())) return null;
	const provider = await getDefaultProvider();
	if (!provider) return null;
	const full = await getProvider(provider.id);
	if (!full) return null;
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) return null;
	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});
	return new LlmQueryExpander(adapter, full.model);
}
