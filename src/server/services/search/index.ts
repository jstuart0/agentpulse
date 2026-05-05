import { config } from "../../config.js";
import { PostgresSearchBackend } from "./postgres-search-backend.js";
import { SqliteFtsBackend } from "./sqlite-fts-backend.js";
import type { SearchBackend } from "./types.js";

/**
 * Backend registry. Dispatches on `config.dialect` so the correct
 * SearchBackend is returned for the active deployment:
 *
 *   - `"sqlite"` → `SqliteFtsBackend` (shadow-index, FTS5 + BM25).
 *   - `"postgres"` → `PostgresSearchBackend` (direct-search, ILIKE).
 *
 * The `postgres-tsvector` backend is reserved for a follow-up campaign
 * that replaces ILIKE with GIN-indexed tsvector for sub-10ms search at
 * scale.
 */

let instance: SearchBackend | null = null;

export function getSearchBackend(): SearchBackend {
	if (instance) return instance;
	if (config.dialect === "postgres") {
		instance = new PostgresSearchBackend();
	} else {
		instance = new SqliteFtsBackend();
	}
	return instance;
}

/** Test-only reset. Do not call from production code. */
export function __resetSearchBackendForTests(): void {
	instance = null;
}

export type {
	SearchBackend,
	SearchFilters,
	SearchHit,
	SearchResult,
	SearchRowKind,
} from "./types.js";
