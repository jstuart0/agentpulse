/**
 * Postgres pg_trgm search-index presence (AGEN-27 / percy TB17 review).
 *
 * Migration 0006 creates 10 GIN trigram indexes when pg_trgm is available
 * and `events` isn't already too large to build them inline at boot (see
 * the migration's own header for the size gate). Either condition can
 * leave some or all of them missing on a live install — search still
 * works via the pre-existing sequential-scan ILIKE path, just slower at
 * scale.
 *
 * `refreshSearchIndexStatus()` is called once at boot, Postgres only
 * (`db/client.ts`'s `initializeDatabase()`, right after migrations
 * complete): it queries `pg_index`/`pg_class` for the expected index names
 * with `indisvalid` true (percy AGEN-27 review, TB22 High — an INVALID
 * index, e.g. left behind by a failed CONCURRENTLY build, must not count as
 * present; Postgres will never actually use it), logs a startup warning if
 * any expected index is missing, and caches the result. `getSearchIndexStatus()`
 * reads that cache synchronously — mirroring `retention-service.ts`'s
 * `getRetentionStatus()` pattern (checked once/periodically, read
 * synchronously by `GET /api/v1/health`) rather than querying on every
 * health check.
 *
 * This list must match the index names migration 0006
 * (`drizzle/postgres/0006_agen27_pg_trgm_search_index.sql`) creates —
 * raw SQL migrations can't import a shared JS constant, so, like
 * `SEARCHABLE_EVENT_TYPES_SQL_LIST` in `postgres-search-backend.ts`, this
 * is a documented, frozen-at-authoring-time duplication.
 */
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { executeRows } from "../../db/sql-helpers.js";

export const EXPECTED_TRIGRAM_INDEXES = [
	"idx_sessions_display_name_trgm",
	"idx_sessions_cwd_trgm",
	"idx_sessions_current_task_trgm",
	"idx_sessions_notes_trgm",
	"idx_events_content_trgm",
	"idx_events_prompt_trgm",
	"idx_events_message_trgm",
	"idx_events_summary_trgm",
	"idx_events_why_trgm",
	"idx_events_title_trgm",
] as const;

export interface SearchIndexStatus {
	present: boolean;
	missing: string[];
}

let cachedStatus: SearchIndexStatus | null = null;

/**
 * Current search-index status for `GET /api/v1/health`. `null` on SQLite
 * (not applicable — FTS5 tables are unconditional) or before the boot-time
 * Postgres check has run.
 */
export function getSearchIndexStatus(): SearchIndexStatus | null {
	return cachedStatus;
}

/** Reset cached state — test-only. */
export function _resetSearchIndexStatusForTest(): void {
	cachedStatus = null;
}

/**
 * Query `pg_indexes` for the expected trigram indexes, cache the result,
 * and log a startup warning if any are missing. Postgres-only; call once
 * after migrations complete. Never throws — a check failure here must
 * never affect boot (it degrades to reporting every index missing, the
 * same as a genuinely absent set).
 */
export async function refreshSearchIndexStatus(db: Db): Promise<SearchIndexStatus> {
	try {
		// A one-shot startup diagnostics read, not a hot path — an IN (...)
		// list of individually bound params is fine here (this isn't subject
		// to the Critical 1 partial-index-planning issue: no partial index
		// predicate needs to match this query at all).
		//
		// percy AGEN-27 review (TB22 High): pg_indexes (the convenience view)
		// doesn't expose indisvalid, so an INVALID index (e.g. a CONCURRENTLY
		// build that failed partway and left an unusable index behind, or one
		// this migration's own IF NOT EXISTS then silently skips fixing)
		// would count as "present" even though Postgres will never actually
		// use it. Querying pg_index joined to pg_class directly and requiring
		// indisvalid catches that.
		const nameList = sql.join(
			EXPECTED_TRIGRAM_INDEXES.map((name): SQL => sql`${name}`),
			sql`, `,
		);
		const rows = await executeRows<{ indexname: string }>(
			db,
			sql`
				SELECT c.relname AS indexname
				FROM pg_index i
				JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relname IN (${nameList})
					AND i.indisvalid
			`,
		);
		const found = new Set(rows.map((r) => r.indexname));
		const missing = EXPECTED_TRIGRAM_INDEXES.filter((name) => !found.has(name));
		const status: SearchIndexStatus = { present: missing.length === 0, missing };
		cachedStatus = status;

		if (missing.length > 0) {
			console.warn(
				`[search] Postgres trigram search indexes missing (${missing.length}/${EXPECTED_TRIGRAM_INDEXES.length}): ${missing.join(", ")} — search falls back to a sequential scan for the affected queries. See deploy/k8s/README.md's "Upgrading to migration 0006" section to build them out-of-band (CREATE INDEX CONCURRENTLY).`,
			);
		}
		return status;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[search] failed to check trigram search-index presence: ${message}`);
		const status: SearchIndexStatus = { present: false, missing: [...EXPECTED_TRIGRAM_INDEXES] };
		cachedStatus = status;
		return status;
	}
}
