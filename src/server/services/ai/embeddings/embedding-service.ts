// SQLite-only feature this campaign. Postgres + pgvector follow-up:
// see thoughts/postgres-followup-plans/pgvector-event-embeddings.md.

import { eq, sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { getDb, getSqlite } from "../../../db/client.js";
import { settings } from "../../../db/schema/index.js";
import { SYNTHETIC_STOP_CONTENT } from "../../event-normalizer.js";
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
 *      runBackfillPass() is the bounded form; embedding-schedule.ts runs it
 *      on a timer, which is what keeps hook-delivered events (never on the
 *      session bus) embedded.
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

const BACKFILL_MAX_CONSECUTIVE_FAILURES = 5;
// Overridable for tests — __setBackfillBackoffForTests.
let _backoffDelayMs = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 30_000);

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
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
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
	// Test bypass — __setEmbeddingAdapterForTests injects this sentinel key.
	if (cachedAdapterKey === "__test_forced__") return cachedAdapter;
	if (config.dialect !== "sqlite" || !isVectorSearchBuildEnabled()) return null;

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

/** The ids one stage-one read looks across above the cursor: bounds the work of a statement however many rows are already embedded. */
export const BACKFILL_ID_WINDOW = 5_000;
/** Most events one batch embeds. */
export const BACKFILL_BATCH_ROWS = 32;
/** What one batch's payloads may add up to; a single larger row is taken alone. */
export const BACKFILL_BATCH_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** A payload larger than this is never handed to SQLite's JSON functions; the event's `content` stands in. */
const PAYLOAD_PARSE_CAP_BYTES = 4 * 1024 * 1024;
/** Cap so a runaway tool output doesn't blow our token budget; most embedding models cap near 512 tokens anyway. */
const EMBED_TEXT_CHARS = 3_000;

const EMBEDDED_TYPE_PLACEHOLDERS = EMBEDDED_EVENT_TYPES.map(() => "?").join(",");

/**
 * SQL for the text to embed for an `events` row, evaluated by SQLite so the
 * payload is never returned to JavaScript. The first non-empty string among
 * prompt, message, summary, why, title wins (a non-string value falls
 * through), then `content`, except that the synthetic Stop marker counts as
 * no text: every turn would otherwise embed a near-duplicate of it. Mirrors
 * the FTS trigger's COALESCE chain. The JSON functions run only on a payload
 * of at most PAYLOAD_PARSE_CAP_BYTES that is valid JSON; anything else falls
 * back to `content`, so a 16 MiB hook payload costs a length check. Truncation
 * is by character (SQLite `substr`), where the old JavaScript cut UTF-16 units.
 * One `?` parameter: the synthetic Stop marker content.
 */
const EVENT_TEXT_SQL = `substr(COALESCE(
	CASE WHEN octet_length(raw_payload) <= ${PAYLOAD_PARSE_CAP_BYTES} THEN
		CASE WHEN json_valid(raw_payload) THEN COALESCE(
			CASE WHEN json_type(raw_payload, '$.prompt') = 'text' THEN NULLIF(json_extract(raw_payload, '$.prompt'), '') END,
			CASE WHEN json_type(raw_payload, '$.message') = 'text' THEN NULLIF(json_extract(raw_payload, '$.message'), '') END,
			CASE WHEN json_type(raw_payload, '$.summary') = 'text' THEN NULLIF(json_extract(raw_payload, '$.summary'), '') END,
			CASE WHEN json_type(raw_payload, '$.why') = 'text' THEN NULLIF(json_extract(raw_payload, '$.why'), '') END,
			CASE WHEN json_type(raw_payload, '$.title') = 'text' THEN NULLIF(json_extract(raw_payload, '$.title'), '') END
		) END
	END,
	CASE WHEN event_type = 'Stop' AND content = ? THEN NULL ELSE NULLIF(content, '') END,
	''
), 1, ${EMBED_TEXT_CHARS})`;

let inlineEmbedOk = 0;
let inlineEmbedFailed = 0;

/** How many inline embeds (one per ingested event) have succeeded and failed since boot. */
export function getInlineEmbedCounters(): { ok: number; failed: number } {
	return { ok: inlineEmbedOk, failed: inlineEmbedFailed };
}

/**
 * Embed and persist a single event. Idempotent — re-embedding overwrites
 * the existing row (used by model-switch flows). Silent no-op when:
 *   - vector search is disabled
 *   - the event is missing or isn't a meaningful type
 *   - text is empty
 *   - adapter resolution fails
 * One statement reads the event's type and, only for an embeddable type, its
 * text; the type is known before the payload is touched and before any
 * adapter is resolved, since most ingested events are not embeddable.
 */
export async function embedEvent(eventId: number): Promise<void> {
	if (config.dialect !== "sqlite" || !isVectorSearchBuildEnabled()) return;
	const row = getSqlite()
		.prepare(
			`SELECT CASE WHEN event_type IN (${EMBEDDED_TYPE_PLACEHOLDERS}) THEN ${EVENT_TEXT_SQL} END AS text
			 FROM events WHERE id = ?`,
		)
		.get(...EMBEDDED_EVENT_TYPES, SYNTHETIC_STOP_CONTENT, eventId) as {
		text: string | null;
	} | null;
	if (!row?.text?.trim()) return;
	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) return;

	try {
		const vector = await adapter.embed(row.text);
		const stmt = getSqlite().prepare(
			"INSERT INTO event_embeddings (event_id, model, dim, vector, created_at) " +
				"VALUES (?, ?, ?, ?, datetime('now')) " +
				"ON CONFLICT(event_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, " +
				"vector = excluded.vector, created_at = excluded.created_at",
		);
		stmt.run(eventId, adapter.model, adapter.dim, vectorToBuffer(vector));
		inlineEmbedOk++;
	} catch (err) {
		// Swallow — backfill will retry, ingest path stays cheap.
		inlineEmbedFailed++;
		console.warn(`[embeddings] embedEvent(${eventId}) failed:`, err);
	}
}

/**
 * Snapshot of indexing progress for the Settings UI. Counts cheap to
 * compute (sqlite COUNT scans index pages, not data).
 */
export async function getBackfillProgress(): Promise<BackfillProgress> {
	if (config.dialect !== "sqlite" || !config.vectorSearchEnabled) return backfillState;
	const totalRow = getSqlite()
		.prepare(
			`SELECT COUNT(*) AS n FROM events WHERE event_type IN (${EMBEDDED_EVENT_TYPES.map(() => "?").join(",")})`,
		)
		.get(...EMBEDDED_EVENT_TYPES) as { n: number };
	const adapter = await resolveEmbeddingAdapter().catch(() => null);
	const model = adapter?.model ?? null;
	let embedded = 0;
	if (model) {
		const r = getSqlite()
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

/** The highest event id, 0 for an empty table: one primary-key read. */
export function readNewestEventId(): number {
	const row = getSqlite().prepare("SELECT COALESCE(MAX(id), ?) AS m FROM events").get(0) as {
		m: number;
	};
	return row.m;
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
	return (await runBackfillPass()).progress;
}

/** How one backfill pass is bounded. The default is a whole walk from id 0, which is what boot and the manual button want. */
export interface BackfillPassOptions {
	/** Start the id cursor here instead of 0; every pending event at or below it is already handled. */
	fromId?: number;
	/** Stop after this many batches, leaving the rest for a later pass. */
	maxBatches?: number;
	/** Sleep this long after each batch, on top of yielding to the event loop. */
	pauseMs?: number;
	/** Open the circuit after this many consecutive failed batches (default 5). 1 is a single probe. */
	failureLimit?: number;
	/**
	 * Count the embeddable events for the progress total (default true). The count
	 * scans the table (`event_type` has no index), so the scheduled pass, which runs
	 * every minute, skips it; `getBackfillProgress` computes its own total.
	 */
	countTotal?: boolean;
}

export interface BackfillPassResult {
	progress: BackfillProgress;
	/** False when nothing was attempted: another pass was running, or there is no adapter. */
	ran: boolean;
	/** Every pending event at or below this id is embedded or marked as having no text, for `model`. */
	endCursor: number;
	model: string | null;
	/** The cursor reached the newest event. */
	reachedEnd: boolean;
	/** The pass stopped because the provider kept failing. */
	circuitOpen: boolean;
	/** The pass ended on a circuit-open or an unexpected error: try again later, not at once. */
	failed: boolean;
	/** Events handled by this pass (embedded or marked textless). */
	handled: number;
}

export async function runBackfillPass(
	options: BackfillPassOptions = {},
): Promise<BackfillPassResult> {
	const idle = (ran: boolean, model: string | null = null): BackfillPassResult => ({
		progress: backfillState,
		ran,
		endCursor: options.fromId ?? 0,
		model,
		reachedEnd: false,
		circuitOpen: false,
		failed: false,
		handled: 0,
	});
	if (config.dialect !== "sqlite" || !isVectorSearchBuildEnabled()) return idle(false);
	if (backfillState.running) return idle(false);

	const adapter = await resolveEmbeddingAdapter();
	if (!adapter) {
		backfillState = {
			...backfillState,
			running: false,
			error: "no embedding provider configured",
		};
		return idle(false);
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

	let processed = 0;
	let circuitOpen = false;
	let reachedEnd = false;
	let threw = false;
	let cursor = options.fromId ?? 0;
	try {
		const placeholders = EMBEDDED_EVENT_TYPES.map(() => "?").join(",");
		if (options.countTotal !== false) {
			const totalRow = getSqlite()
				.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type IN (${placeholders})`)
				.get(...EMBEDDED_EVENT_TYPES) as { n: number };
			backfillState.total = totalRow.n;
		}

		// An id cursor walks the table once. Each pass reads (stage one) the ids
		// and payload sizes of up to a batch of pending rows inside an id window
		// above the cursor, then (stage two) extracts text in SQL for the longest
		// prefix whose payloads add up to the byte budget. An empty window moves
		// the cursor on, since retention leaves gaps; the run ends when the cursor
		// reaches the highest id, read again at that point so events ingested
		// during the run are covered.
		const sqlite = getSqlite();
		const readMaxEventId = () =>
			(sqlite.prepare("SELECT COALESCE(MAX(id), ?) AS m FROM events").get(0) as { m: number }).m;
		const stageOne = sqlite.prepare(
			`SELECT e.id AS id, COALESCE(octet_length(e.raw_payload), 0) AS payloadBytes
			 FROM events e
			 LEFT JOIN event_embeddings v ON v.event_id = e.id AND v.model = ?
			 WHERE e.id > ? AND e.id <= ? AND e.event_type IN (${placeholders}) AND v.event_id IS NULL
			 ORDER BY e.id ASC
			 LIMIT ${BACKFILL_BATCH_ROWS}`,
		);
		// Placeholder INSERT for events that have no extractable text. Without
		// it the pending query keeps re-surfacing them and the run never makes
		// forward progress. dim=0 + empty buffer is silently filtered by the
		// cosine query (which requires dim = adapter.dim).
		const skipMarker = sqlite.prepare(
			"INSERT OR IGNORE INTO event_embeddings (event_id, model, dim, vector, created_at) " +
				"VALUES (?, ?, 0, X'', datetime('now'))",
		);
		const insert = sqlite.prepare(
			"INSERT INTO event_embeddings (event_id, model, dim, vector, created_at) " +
				"VALUES (?, ?, ?, ?, datetime('now')) " +
				"ON CONFLICT(event_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, " +
				"vector = excluded.vector, created_at = excluded.created_at",
		);
		const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

		const failureLimit = options.failureLimit ?? BACKFILL_MAX_CONSECUTIVE_FAILURES;
		let consecutiveFailures = 0;
		let batches = 0;
		let maxId = readMaxEventId();
		while (true) {
			if (cursor >= maxId) {
				maxId = readMaxEventId();
				if (cursor >= maxId) {
					reachedEnd = true;
					break;
				}
			}
			if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
			const windowEnd = cursor + BACKFILL_ID_WINDOW;
			const candidates = stageOne.all(
				adapter.model,
				cursor,
				windowEnd,
				...EMBEDDED_EVENT_TYPES,
			) as Array<{
				id: number;
				payloadBytes: number;
			}>;
			if (candidates.length === 0) {
				cursor = Math.min(windowEnd, maxId);
				await yieldToLoop();
				continue;
			}

			// The longest prefix within the byte budget, and always at least one row.
			let payloadBytes = 0;
			let take = 0;
			for (const c of candidates) {
				if (take > 0 && payloadBytes + c.payloadBytes > BACKFILL_BATCH_PAYLOAD_BYTES) break;
				payloadBytes += c.payloadBytes;
				take++;
			}
			const batch = candidates.slice(0, take);
			const nextCursor =
				take === candidates.length && candidates.length < BACKFILL_BATCH_ROWS
					? Math.min(windowEnd, maxId)
					: (batch[batch.length - 1] as { id: number }).id;
			const rows = sqlite
				.prepare(
					`SELECT e.id AS id, ${EVENT_TEXT_SQL} AS text FROM events e
					 WHERE e.id IN (${batch.map(() => "?").join(",")}) ORDER BY e.id ASC`,
				)
				.all(SYNTHETIC_STOP_CONTENT, ...batch.map((c) => c.id)) as Array<{
				id: number;
				text: string;
			}>;

			const texts: string[] = [];
			const ids: number[] = [];
			let skipped = 0;
			for (const row of rows) {
				if (!row.text.trim()) {
					skipMarker.run(row.id, adapter.model);
					skipped += 1;
					continue;
				}
				texts.push(row.text);
				ids.push(row.id);
			}

			const batchStartedAt = Date.now();
			console.log(
				JSON.stringify({
					kind: "embedding_backfill_batch_started",
					level: "info",
					cursor,
					rows: batch.length,
					payloadBytes,
				}),
			);
			if (texts.length > 0) {
				let vectors: Float32Array[];
				try {
					vectors = adapter.embedBatch
						? await adapter.embedBatch(texts)
						: await Promise.all(texts.map((t) => adapter.embed(t)));
				} catch (err) {
					consecutiveFailures++;
					backfillState.error = err instanceof Error ? err.message : String(err);
					console.warn("[embeddings] batch embed failed:", err);
					if (consecutiveFailures >= failureLimit) {
						console.warn(
							JSON.stringify({
								kind: "embedding_circuit_open",
								level: "warn",
								consecutiveFailures,
								model: adapter.model,
								lastError: backfillState.error,
							}),
						);
						backfillState.error = `circuit open after ${consecutiveFailures} consecutive adapter failures`;
						circuitOpen = true;
						break;
					}
					// The cursor stays where it is, so the same rows are tried again.
					const delay = _backoffDelayMs(consecutiveFailures);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}

				const txn = sqlite.transaction((embedded: Array<{ id: number; vec: Float32Array }>) => {
					for (const r of embedded) {
						insert.run(r.id, adapter.model, adapter.dim, vectorToBuffer(r.vec));
					}
				});
				txn(ids.map((id, i) => ({ id, vec: vectors[i] as Float32Array })));
				consecutiveFailures = 0; // reset on successful batch
			}
			processed += rows.length;
			batches++;
			cursor = nextCursor;
			console.log(
				JSON.stringify({
					kind: "embedding_backfill_batch",
					level: "info",
					cursor,
					embedded: texts.length,
					skipped,
					ms: Date.now() - batchStartedAt,
				}),
			);

			backfillState.embedded = processed;
			backfillState.pending = Math.max(0, backfillState.total - processed);
			// Yield so the event loop processes other work between batches.
			await yieldToLoop();
			if (options.pauseMs) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
		}

		backfillState.running = false;
		backfillState.finishedAt = new Date().toISOString();
		if (circuitOpen) {
			console.warn(
				`[embeddings] backfill paused: circuit open after ${failureLimit} consecutive adapter failures — the scheduled backfill tries again later`,
			);
		} else if (reachedEnd) {
			console.log(
				`[embeddings] backfill complete: ${processed} events indexed with ${adapter.model}`,
			);
		}
	} catch (err) {
		threw = true;
		backfillState.running = false;
		backfillState.error = err instanceof Error ? err.message : String(err);
		backfillState.finishedAt = new Date().toISOString();
		console.warn("[embeddings] backfill failed:", err);
	}
	return {
		progress: backfillState,
		ran: true,
		endCursor: cursor,
		model: adapter.model,
		reachedEnd,
		circuitOpen,
		failed: circuitOpen || threw,
		handled: processed,
	};
}

/**
 * Read an event's vector back from the event_embeddings table. Returns null if
 * missing, or the dim doesn't match the active model (stale row from a model
 * swap), or not on SQLite (embeddings are SQLite-only this campaign).
 */
export function loadEventVector(eventId: number, expectedModel: string): Float32Array | null {
	if (config.dialect !== "sqlite" || !config.vectorSearchEnabled) return null;
	const row = getSqlite()
		.prepare("SELECT vector, model, dim FROM event_embeddings WHERE event_id = ? AND model = ?")
		.get(eventId, expectedModel) as { vector: Buffer; model: string; dim: number } | undefined;
	if (!row) return null;
	const view = new Uint8Array(row.vector);
	const f32 = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
	return f32;
}

/** Test-only — zero the inline embed counters. */
export function __resetInlineEmbedCountersForTests(): void {
	inlineEmbedOk = 0;
	inlineEmbedFailed = 0;
}

/** Test-only — drop the cached adapter so a settings change picks up. */
export function __resetEmbeddingAdapterForTests(): void {
	cachedAdapter = null;
	cachedAdapterKey = null;
}

/** Test-only — inject a specific adapter, bypassing provider resolution. */
export function __setEmbeddingAdapterForTests(adapter: EmbeddingAdapter | null): void {
	cachedAdapter = adapter;
	cachedAdapterKey = "__test_forced__";
}

/** Test-only — override per-attempt backoff delay (use () => 0 for instant tests). */
export function __setBackfillBackoffForTests(fn: (attempt: number) => number): void {
	_backoffDelayMs = fn;
}

/** Suppress unused-import lint when the file is imported but no exports used. */
void sql;
