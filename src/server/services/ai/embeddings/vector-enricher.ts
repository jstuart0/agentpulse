// SQLite-only feature this campaign. Postgres + pgvector follow-up:
// see thoughts/postgres-followup-plans/pgvector-event-embeddings.md.

import { config } from "../../../config.js";
import { isVectorSearchActive } from "../feature.js";
import type { EnrichmentResult, SemanticEnricher } from "../semantic-enricher.js";
import { resolveEmbeddingAdapter } from "./embedding-service.js";
import type { EmbeddingAdapter } from "./types.js";
import { scanSessionSimilarity } from "./vector-scan.js";

/**
 * Vector-similarity enricher. Embeds the user's query, scans the
 * `event_embeddings` table for the active model, and aggregates per-
 * session cosine scores. Populates `directHits` on EnrichmentResult so
 * the resolver pulls the matched sessions even when no lexical token
 * lines up.
 *
 * Scoring per session combines max + log(count) just like the lexical
 * path so a session with many moderate matches outranks one with a
 * single rare hit.
 *
 * The scan itself lives in `vector-scan.ts`: exact cosine over the newest
 * vectors of the active model, read a few at a time through an index under
 * a row and time budget and a CPU share. Older events are found by keyword.
 */
export class VectorEmbeddingEnricher implements SemanticEnricher {
	readonly name = "vector-embedding" as const;

	constructor(
		private readonly adapter: EmbeddingAdapter,
		/** Top-N sessions to surface. Trimmed by resolver downstream too. */
		private readonly topN = 20,
	) {}

	async enrich(query: string): Promise<EnrichmentResult> {
		if (config.dialect !== "sqlite") return EMPTY;
		const trimmed = query.trim();
		if (!trimmed) return EMPTY;
		let queryVec: Float32Array;
		try {
			queryVec = await this.adapter.embed(trimmed);
		} catch {
			return EMPTY;
		}

		let result: Awaited<ReturnType<typeof scanSessionSimilarity>>;
		console.log(
			JSON.stringify({
				kind: "ask_vector_scan_started",
				level: "info",
				model: this.adapter.model,
				dim: this.adapter.dim,
			}),
		);
		try {
			result = await scanSessionSimilarity(queryVec, {
				model: this.adapter.model,
				dim: this.adapter.dim,
			});
		} catch {
			// The scan has already logged why (once per boot per reason). Semantic
			// enrichment is an optional extra; the Ask turn goes on without it.
			return EMPTY;
		}
		const { perSession, stats } = result;
		console.log(
			JSON.stringify({
				kind: "ask_vector_scan",
				level: "info",
				returned: stats.returned,
				scored: stats.scored,
				skipped: stats.skipped,
				statements: stats.statements,
				stopReason: stats.stopReason,
				ms: Math.round(stats.ms),
				busyMs: Math.round(stats.busyMs),
				maxSliceMs: Math.round(stats.maxSliceMs),
				oldestEventAt: stats.oldestEventAt,
			}),
		);

		const directHits = new Map<string, number>();
		for (const [sessionId, { max, count }] of perSession) {
			directHits.set(sessionId, max + Math.log1p(count) * 0.05);
		}
		// Cap at topN so the resolver doesn't try to pool-extend with
		// hundreds of marginal sessions; downstream merge keeps the best.
		const topEntries = [...directHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.topN);
		return { extraTerms: [], directHits: new Map(topEntries) };
	}
}

const EMPTY: EnrichmentResult = { extraTerms: [], directHits: new Map() };

/**
 * Factory: returns a VectorEmbeddingEnricher when vector search is on
 * and the embedding adapter resolves cleanly. Null otherwise so the
 * SemanticEnricher composition layer can skip it without checks.
 */
export async function getVectorEnricher(): Promise<SemanticEnricher | null> {
	if (config.dialect !== "sqlite" || !(await isVectorSearchActive())) return null;
	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) return null;
	return new VectorEmbeddingEnricher(adapter);
}
