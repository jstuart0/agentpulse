import { config } from "../../config.js";
import { SqliteFtsBackend } from "./sqlite-fts-backend.js";
import type { SearchBackend } from "./types.js";

/**
 * Backend registry. Returns the appropriate SearchBackend for the
 * current deployment. Today only SQLite FTS5 is implemented; the
 * Postgres tsvector backend will slot in here when the Postgres
 * backend plan (see thoughts/2026-04-24-postgres-backend-plan.md)
 * reaches Phase 3 or later.
 */

let instance: SearchBackend | null = null;

export function getSearchBackend(): SearchBackend {
	if (instance) return instance;
	if (!config.useSqlite) {
		// Postgres backend not yet implemented — see tracking issue #12.
		// Fall through to SQLite so tests/dev don't break; the actual
		// Postgres deployment path logs a warning at boot anyway.
		instance = new SqliteFtsBackend();
		return instance;
	}
	instance = new SqliteFtsBackend();
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
