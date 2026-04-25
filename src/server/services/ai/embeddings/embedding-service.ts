import { eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../../db/client.js";
import { events, settings } from "../../../db/schema.js";
import {
	DEFAULT_EMBEDDING_MODEL,
	VECTOR_SEARCH_MODEL_KEY,
	VECTOR_SEARCH_PROVIDER_ID_KEY,
	isVectorSearchBuildEnabled,
} from "../feature.js";
import { getDefaultProvider, getProvider } from "../providers-service.js";
import { createOllamaEmbeddingAdapter } from "./ollama.js";
import { type EmbeddingAdapter, vectorToBuffer } from "./types.js";

/**
 * Pulls everything together for "make/keep an event embedded":
 *
 *   1. resolveAdapter() picks the embedding model + endpoint from
 *      settings (or falls back to the default LLM provider's baseUrl
 *      with mxbai-embed-large).
 *   2. embedEvent(id) extracts text the same way the FTS trigger does
 *      (json_extract over raw_payload + content fallback), embeds it,
 *      writes the float32 vector as a blob.
 *   3. runBackfill() finds events without an embedding (or with a stale
 *      model name) and processes them in batches with progress logging.
 *
 * All paths are no-ops when AGENTPULSE_VECTOR_SEARCH=false. Designed to
 * run async / fire-and-forget from the ingest hot path so adding this
 * doesn't add latency to the hook endpoint.
 */

const EMBEDDED_EVENT_TYPES = [
	"UserPromptSubmit",
	"AssistantMessage",
	"Stop",
	"TaskCreated",
	"TaskCompleted",
	"SubagentStop",
	"SessionEnd",
	"AiProposal",
	"AiReport",
	"AiHitlRequest",
] as const;

export interface BackfillProgress {
	total: number;
	embedded: number;
	pending: number;
	model: string | null;
	running: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
}

let cachedAdapter: EmbeddingAdapter | null = null;
let cachedAdapterKey: string | null = null;

let backfillState: BackfillProgress = {
	total: 0,
	embedded: 0,
	pending: 0,
	model: null,
	running: false,
	startedAt: null,
	finishedAt: null,
	error: null,
};

async function readSetting(key: string): Promise<unknown> {
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
	return row?.value ?? null;
}

/**
 * Build (or reuse) the embedding adapter. Resolution order:
 *   1. Settings: vectorSearch.providerId + vectorSearch.model
 *   2. Default LLM provider (must be openai_compatible / ollama)
 *      with vectorSearch.model (or DEFAULT_EMBEDDING_MODEL)
 *
 * Returns null when no compatible provider exists. Callers must
 * tolerate null — vector search just becomes a no-op.
 */
export async function resolveEmbeddingAdapter(): Promise<EmbeddingAdapter | null> {
	if (!isVectorSearchBuildEnabled()) return null;

	const providerId = (await readSetting(VECTOR_SEARCH_PROVIDER_ID_KEY)) as string | null;
	const model =
		((await readSetting(VECTOR_SEARCH_MODEL_KEY)) as string | null) ?? DEFAULT_EMBEDDING_MODEL;

	let baseUrl: string | null = null;
	if (providerId) {
		const p = await getProvider(providerId);
		if (p?.baseUrl) baseUrl = p.baseUrl;
	}
	if (!baseUrl) {
		const def = await getDefaultProvider();
		if (def) {
			const full = await getProvider(def.id);
			if (full?.baseUrl) baseUrl = full.baseUrl;
		}
	}
	if (!baseUrl) return null;

	// Cache by (baseUrl, model) so repeated calls don't keep re-probing
	// the dim. Invalidates automatically when either changes.
	const cacheKey = `${baseUrl}::${model}`;
	if (cachedAdapter && cachedAdapterKey === cacheKey) return cachedAdapter;
	try {
		cachedAdapter = await createOllamaEmbeddingAdapter({ baseUrl, model });
		cachedAdapterKey = cacheKey;
		return cachedAdapter;
	} catch (err) {
		console.warn(`[embeddings] adapter creation failed for ${model} @ ${baseUrl}:`, err);
		return null;
	}
}

/**
 * Compose the text to embed for a single event row. Mirrors the FTS
 * trigger's COALESCE chain so the two indexes see equivalent input.
 */
function eventTextFromRow(row: {
	rawPayload: unknown;
	content: string | null;
}): string {
	const p = (row.rawPayload ?? {}) as Record<string, unknown>;
	const text =
		(typeof p.prompt === "string" && p.prompt) ||
		(typeof p.message === "string" && p.message) ||
		(typeof p.summary === "string" && p.summary) ||
		(typeof p.why === "string" && p.why) ||
		(typeof p.title === "string" && p.title) ||
		row.content ||
		"";
	// Cap so a runaway tool output doesn't blow our token budget. Most
	// embedding models cap at 512 tokens anyway; ~3000 chars is a
	// comfortable upper bound.
	return text.slice(0, 3000);
}

/**
 * Embed and persist a single event. Idempotent — re-embedding overwrites
 * the existing row (used by model-switch flows). Silent no-op when:
 *   - vector search is disabled
 *   - adapter resolution fails
 *   - the event isn't a meaningful type
 *   - text is empty
 */
export async function embedEvent(eventId: number): Promise<void> {
	if (!isVectorSearchBuildEnabled()) return;
	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) return;

	const [row] = await db
		.select({
			id: events.id,
			eventType: events.eventType,
			content: events.content,
			rawPayload: events.rawPayload,
		})
		.from(events)
		.where(eq(events.id, eventId))
		.limit(1);
	if (!row) return;
	if (!EMBEDDED_EVENT_TYPES.includes(row.eventType as (typeof EMBEDDED_EVENT_TYPES)[number])) {
		return;
	}
	const text = eventTextFromRow(row);
	if (!text.trim()) return;

	try {
		const vector = await adapter.embed(text);
		const stmt = sqlite.prepare(
			"INSERT INTO event_embeddings (event_id, model, dim, vector, created_at) " +
				"VALUES (?, ?, ?, ?, datetime('now')) " +
				"ON CONFLICT(event_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, " +
				"vector = excluded.vector, created_at = excluded.created_at",
		);
		stmt.run(eventId, adapter.model, adapter.dim, vectorToBuffer(vector));
	} catch (err) {
		// Swallow — backfill will retry, ingest path stays cheap.
		console.warn(`[embeddings] embedEvent(${eventId}) failed:`, err);
	}
}

/**
 * Snapshot of indexing progress for the Settings UI. Counts cheap to
 * compute (sqlite COUNT scans index pages, not data).
 */
export async function getBackfillProgress(): Promise<BackfillProgress> {
	const totalRow = sqlite
		.prepare(
			`SELECT COUNT(*) AS n FROM events WHERE event_type IN (${EMBEDDED_EVENT_TYPES.map(() => "?").join(",")})`,
		)
		.get(...EMBEDDED_EVENT_TYPES) as { n: number };
	const adapter = await resolveEmbeddingAdapter().catch(() => null);
	const model = adapter?.model ?? null;
	let embedded = 0;
	if (model) {
		const r = sqlite
			.prepare("SELECT COUNT(*) AS n FROM event_embeddings WHERE model = ?")
			.get(model) as { n: number };
		embedded = r.n;
	}
	const total = totalRow.n;
	return {
		...backfillState,
		total,
		embedded,
		pending: Math.max(0, total - embedded),
		model,
	};
}

/**
 * Walk the events table and embed anything missing for the active model.
 * Concurrency-1 today (Ollama doesn't love parallel embed calls on a
 * single GPU). Yields control between batches so the rest of the server
 * stays responsive — this can run for tens of minutes on a fresh DB.
 *
 * Returns immediately if a backfill is already running.
 */
export async function runBackfill(): Promise<BackfillProgress> {
	if (!isVectorSearchBuildEnabled()) return backfillState;
	if (backfillState.running) return backfillState;

	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) {
		backfillState = {
			...backfillState,
			running: false,
			error: "no embedding provider configured",
		};
		return backfillState;
	}

	backfillState = {
		total: 0,
		embedded: 0,
		pending: 0,
		model: adapter.model,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		error: null,
	};

	try {
		const placeholders = EMBEDDED_EVENT_TYPES.map(() => "?").join(",");
		const totalRow = sqlite
			.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type IN (${placeholders})`)
			.get(...EMBEDDED_EVENT_TYPES) as { n: number };
		backfillState.total = totalRow.n;

		// Loop in batches; each batch picks up rows missing this model's
		// vector. Survives concurrent ingest because new events get embedded
		// inline and queries for "missing" reflect that immediately.
		const batchSize = 32;
		let processed = 0;
		while (true) {
			const batch = sqlite
				.prepare(
					`SELECT e.id, e.event_type AS eventType, e.content, e.raw_payload AS rawPayload
					 FROM events e
					 LEFT JOIN event_embeddings v ON v.event_id = e.id AND v.model = ?
					 WHERE e.event_type IN (${placeholders}) AND v.event_id IS NULL
					 ORDER BY e.id ASC
					 LIMIT ${batchSize}`,
				)
				.all(adapter.model, ...EMBEDDED_EVENT_TYPES) as Array<{
				id: number;
				eventType: string;
				content: string | null;
				rawPayload: string;
			}>;
			if (batch.length === 0) break;

			const texts: string[] = [];
			const ids: number[] = [];
			// Placeholder INSERT for events that have no extractable text.
			// Without it, the LEFT JOIN keeps re-surfacing them on every
			// batch query and the loop never makes forward progress (we
			// burned 22 events × N pods diagnosing exactly this). dim=0 +
			// empty buffer is silently filtered by the cosine query
			// (which requires dim = adapter.dim).
			const skipMarker = sqlite.prepare(
				"INSERT OR IGNORE INTO event_embeddings (event_id, model, dim, vector, created_at) " +
					"VALUES (?, ?, 0, X'', datetime('now'))",
			);
			for (const row of batch) {
				const parsed =
					typeof row.rawPayload === "string"
						? (JSON.parse(row.rawPayload) as unknown)
						: row.rawPayload;
				const text = eventTextFromRow({
					rawPayload: parsed,
					content: row.content,
				});
				if (!text.trim()) {
					skipMarker.run(row.id, adapter.model);
					processed += 1;
					continue;
				}
				texts.push(text);
				ids.push(row.id);
			}

			if (texts.length > 0) {
				let vectors: Float32Array[];
				try {
					vectors = adapter.embedBatch
						? await adapter.embedBatch(texts)
						: await Promise.all(texts.map((t) => adapter.embed(t)));
				} catch (err) {
					backfillState.error = err instanceof Error ? err.message : String(err);
					console.warn("[embeddings] batch embed failed:", err);
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}

				const insert = sqlite.prepare(
					"INSERT INTO event_embeddings (event_id, model, dim, vector, created_at) " +
						"VALUES (?, ?, ?, ?, datetime('now')) " +
						"ON CONFLICT(event_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, " +
						"vector = excluded.vector, created_at = excluded.created_at",
				);
				const txn = sqlite.transaction((rows: Array<{ id: number; vec: Float32Array }>) => {
					for (const r of rows) {
						insert.run(r.id, adapter.model, adapter.dim, vectorToBuffer(r.vec));
					}
				});
				txn(ids.map((id, i) => ({ id, vec: vectors[i] })));
				processed += texts.length;
			} else {
				processed += batch.length;
			}

			backfillState.embedded = processed;
			backfillState.pending = Math.max(0, backfillState.total - processed);
			// Yield so the event loop processes other work between batches.
			await new Promise((r) => setTimeout(r, 0));
		}

		backfillState.running = false;
		backfillState.finishedAt = new Date().toISOString();
		console.log(
			`[embeddings] backfill complete: ${processed} events indexed with ${adapter.model}`,
		);
	} catch (err) {
		backfillState.running = false;
		backfillState.error = err instanceof Error ? err.message : String(err);
		backfillState.finishedAt = new Date().toISOString();
		console.warn("[embeddings] backfill failed:", err);
	}
	return backfillState;
}

/**
 * Boot-time hook: kick off a non-blocking backfill if there's a gap
 * between events count and embedded count. Safe to call unconditionally
 * from server startup — bails out fast when the build flag is off.
 */
export async function startBackfillIfNeeded(): Promise<void> {
	if (!isVectorSearchBuildEnabled()) return;
	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) {
		console.warn(
			"[embeddings] vector search built in but no embedding provider — Settings → AI → Vector search will surface a clearer error.",
		);
		return;
	}
	const progress = await getBackfillProgress();
	if (progress.pending > 0 && !progress.running) {
		console.log(
			`[embeddings] starting backfill: ${progress.pending} events to index with ${adapter.model}`,
		);
		// Fire and forget — the server doesn't wait for backfill to finish.
		void runBackfill();
	}
}

/**
 * Read an event's vector back from sqlite. Returns null if missing or
 * the dim doesn't match the active model (stale row from a model swap).
 */
export function loadEventVector(eventId: number, expectedModel: string): Float32Array | null {
	const row = sqlite
		.prepare("SELECT vector, model, dim FROM event_embeddings WHERE event_id = ? AND model = ?")
		.get(eventId, expectedModel) as { vector: Buffer; model: string; dim: number } | undefined;
	if (!row) return null;
	const view = new Uint8Array(row.vector);
	const f32 = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
	return f32;
}

/** Test-only — drop the cached adapter so a settings change picks up. */
export function __resetEmbeddingAdapterForTests(): void {
	cachedAdapter = null;
	cachedAdapterKey = null;
}

/** Suppress unused-import lint when the file is imported but no exports used. */
void sql;
