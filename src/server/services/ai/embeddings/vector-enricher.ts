import { sqlite } from "../../../db/client.js";
import { isVectorSearchActive } from "../feature.js";
import type { EnrichmentResult, SemanticEnricher } from "../semantic-enricher.js";
import { resolveEmbeddingAdapter } from "./embedding-service.js";
import { type EmbeddingAdapter, bufferToVector, cosineSimilarity } from "./types.js";

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
 * Brute-force scan over all rows for the active model. With ~10K
 * events × 1024-dim float32 = 40MB and a single dot-product per
 * row we're well under 100ms even on the modest k8s pod we're
 * running. Swap to sqlite-vss when we hit ~100K events.
 */
export class VectorEmbeddingEnricher implements SemanticEnricher {
	readonly name = "vector-embedding" as const;

	constructor(
		private readonly adapter: EmbeddingAdapter,
		/** Top-N sessions to surface. Trimmed by resolver downstream too. */
		private readonly topN = 20,
	) {}

	async enrich(query: string): Promise<EnrichmentResult> {
		const trimmed = query.trim();
		if (!trimmed) return EMPTY;
		let queryVec: Float32Array;
		try {
			queryVec = await this.adapter.embed(trimmed);
		} catch {
			return EMPTY;
		}

		// Pull only rows that match the active model — different models
		// have different dims and different vector spaces; mixing them
		// in one cosine query is meaningless.
		const rows = sqlite
			.prepare(
				`SELECT v.event_id AS eventId, v.vector AS vector, e.session_id AS sessionId
				 FROM event_embeddings v
				 JOIN events e ON e.id = v.event_id
				 WHERE v.model = ? AND v.dim = ?`,
			)
			.all(this.adapter.model, this.adapter.dim) as Array<{
			eventId: number;
			vector: Buffer;
			sessionId: string;
		}>;

		if (rows.length === 0) {
			return EMPTY;
		}

		// Per-session aggregate: max score + count of hits above a low
		// floor. Floor screens out the long tail of marginal matches that
		// would otherwise inflate the count term.
		const FLOOR = 0.4; // typical for unit-normalized embeddings;
		// below this, hits are essentially noise on retrieval-trained models
		const per = new Map<string, { max: number; count: number }>();
		for (const row of rows) {
			const v = bufferToVector(row.vector);
			const sim = cosineSimilarity(queryVec, v);
			if (sim < FLOOR) continue;
			const entry = per.get(row.sessionId) ?? { max: 0, count: 0 };
			if (sim > entry.max) entry.max = sim;
			entry.count += 1;
			per.set(row.sessionId, entry);
		}

		const directHits = new Map<string, number>();
		for (const [sessionId, { max, count }] of per) {
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
	if (!(await isVectorSearchActive())) return null;
	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) return null;
	return new VectorEmbeddingEnricher(adapter);
}
