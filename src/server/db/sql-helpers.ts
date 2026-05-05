/**
 * Dialect-aware SQL fragment helpers.
 *
 * Each helper branches on `config.dialect` and returns a Drizzle `SQL`
 * fragment ready to embed in a query via the `sql` template tag. All
 * user-supplied values are passed as bound parameters through the Drizzle
 * template — never string-interpolated into SQL text.
 *
 * Usage:
 *   import { nowSql, likeStartsWith, executeRows } from "../db/sql-helpers.js";
 *   .where(gt(sessions.updatedAt, nowSql()))
 *   .where(likeStartsWith(sessions.cwd, "/home/user"))
 *   const rows = await executeRows<MyRowType>(db, sql`SELECT ...`);
 */

import { type AnyColumn, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "./client.js";

// ── executeRows ───────────────────────────────────────────────────────────────

/**
 * Execute a raw SQL query and return an array of typed rows. Normalises the
 * return-shape difference between the SQLite and Postgres Drizzle adapters:
 *
 *   SQLite (bun-sqlite): `db.all(query)` → TRow[]          (sync, wrapped here as Promise)
 *   Postgres (postgres-js): `db.execute(query)` → TRow[]   (async, already an array)
 *
 * Both adapters are typed as the SQLite adapter in client.ts (Phase 1 bridge
 * cast); we use a type assertion to reach the Postgres `execute` at runtime
 * when `config.dialect === "postgres"`.
 */
export async function executeRows<TRow extends Record<string, unknown>>(
	db: Db,
	query: SQL,
): Promise<TRow[]> {
	if (config.dialect === "postgres") {
		// At runtime the Postgres db is a drizzle-orm/postgres-js instance.
		// The Phase 1 bridge casts it to the SQLite type; reach past the cast
		// to call .execute() which returns Promise<TRow[]> on postgres-js.
		const pgDb = db as unknown as { execute: (q: SQL) => Promise<TRow[]> };
		return pgDb.execute(query);
	}
	// SQLite path: .all() is synchronous on the bun-sqlite adapter.
	const sqliteDb = db as unknown as { all: (q: SQL) => TRow[] };
	return Promise.resolve(sqliteDb.all(query));
}

// ── nowSql ────────────────────────────────────────────────────────────────────

/**
 * Returns a SQL fragment for the current timestamp.
 *
 *   SQLite:   (datetime('now'))
 *   Postgres: CURRENT_TIMESTAMP
 */
export function nowSql(): SQL {
	if (config.dialect === "postgres") {
		return sql`CURRENT_TIMESTAMP`;
	}
	return sql`(datetime('now'))`;
}

// ── intervalSecondsSql ────────────────────────────────────────────────────────

/**
 * Returns a SQL fragment representing a duration of `seconds` seconds, ready
 * to be composed into an arithmetic expression against a timestamp column.
 *
 *   SQLite:   '+' || <seconds> || ' seconds'
 *             (pass as the second arg to datetime('now', …) in the caller)
 *   Postgres: (<seconds> * INTERVAL '1 second')
 *
 * Validation: `seconds` must be a non-negative integer. Throws otherwise
 * (Decision 31 — fail loudly at the helper boundary, never silently emit
 * malformed SQL).
 */
export function intervalSecondsSql(seconds: number): SQL {
	if (!Number.isInteger(seconds) || seconds < 0) {
		throw new Error(
			`intervalSecondsSql requires a non-negative integer, got: ${JSON.stringify(seconds)}`,
		);
	}
	if (config.dialect === "postgres") {
		// seconds is a bound numeric parameter — Drizzle template wraps it safely.
		return sql`(${seconds} * INTERVAL '1 second')`;
	}
	// SQLite: build the modifier string as a bound param so the integer value
	// travels through the prepared-statement binding layer, not SQL text.
	return sql`'+' || ${seconds} || ' seconds'`;
}

// ── jsonExtractText ───────────────────────────────────────────────────────────

/**
 * Returns a SQL expression that extracts a top-level JSON field as text.
 *
 * `path` must match `$.fieldName` (single-level only; nested paths are not
 * supported — extend when needed). Throws on any other shape (validation gate
 * prevents accidental SQL injection through the path argument).
 *
 *   SQLite:   json_extract(<col>, <path>)
 *   Postgres: (<col>::json)->><fieldName>
 *
 * The path string is passed as a bound parameter on SQLite; the field name
 * is passed as a bound parameter on Postgres (after stripping the `$.` prefix).
 */
export function jsonExtractText(col: AnyColumn | SQLWrapper, path: string): SQL {
	const PATH_RE = /^\$\.[a-zA-Z_][a-zA-Z0-9_]*$/;
	if (!PATH_RE.test(path)) {
		throw new Error(`jsonExtractText: path must match $.fieldName (got: ${JSON.stringify(path)})`);
	}
	if (config.dialect === "postgres") {
		// Strip "$."; pass the bare field name as a bound param to ->>.
		const field = path.slice(2);
		return sql`(${col as SQL}::json)->>${field}`;
	}
	// SQLite: path is a bound string parameter.
	return sql`json_extract(${col as SQL}, ${path})`;
}

// ── likeStartsWith ────────────────────────────────────────────────────────────

/**
 * Returns a SQL LIKE / ILIKE fragment that matches values starting with
 * `prefix`. The `%` wildcard is appended at this layer (not by the caller)
 * and the full pattern is passed as a bound parameter.
 *
 *   SQLite:   <col> LIKE  '<prefix>%'
 *   Postgres: <col> ILIKE '<prefix>%'
 */
export function likeStartsWith(col: AnyColumn | SQLWrapper, prefix: string): SQL {
	const pattern = `${prefix}%`;
	if (config.dialect === "postgres") {
		return sql`${col as SQL} ILIKE ${pattern}`;
	}
	return sql`${col as SQL} LIKE ${pattern}`;
}

// ── isUniqueViolationError ────────────────────────────────────────────────────

/**
 * Returns true when `err` represents a unique-constraint violation on either
 * supported backend:
 *
 *   Postgres (postgres-js): error.code === '23505' (SQLSTATE unique_violation)
 *   SQLite   (bun:sqlite via Drizzle): error.message contains
 *            'SQLITE_CONSTRAINT_UNIQUE'
 *
 * Used by callers that need to distinguish a unique-violation from other DB
 * errors (e.g. enqueueRun's race-recovery catch). Do NOT use this to swallow
 * arbitrary errors — always re-throw if the error does not match.
 */
export function isUniqueViolationError(err: unknown): boolean {
	if (!err) return false;
	// postgres-js exposes SQLSTATE as .code on the error object.
	// Drizzle wraps postgres-js errors in DrizzleQueryError with .cause pointing
	// to the original error — check both the error itself and one level of cause.
	if (typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (obj.code === "23505") return true;
		// Check DrizzleQueryError.cause (set when Drizzle wraps a postgres-js error).
		const cause = obj.cause;
		if (cause && typeof cause === "object" && (cause as Record<string, unknown>).code === "23505") {
			return true;
		}
	}
	// bun:sqlite surfaces the SQLite extended error name in the message.
	const message = err instanceof Error ? err.message : String(err);
	return message.includes("SQLITE_CONSTRAINT_UNIQUE");
}

// ── likeContains ─────────────────────────────────────────────────────────────

/**
 * Returns a SQL LIKE / ILIKE fragment that matches values containing
 * `fragment` anywhere. Both `%` boundaries are appended at this layer and
 * the full pattern is passed as a bound parameter.
 *
 *   SQLite:   <col> LIKE  '%<fragment>%'
 *   Postgres: <col> ILIKE '%<fragment>%'
 */
export function likeContains(col: AnyColumn | SQLWrapper, fragment: string): SQL {
	const pattern = `%${fragment}%`;
	if (config.dialect === "postgres") {
		return sql`${col as SQL} ILIKE ${pattern}`;
	}
	return sql`${col as SQL} LIKE ${pattern}`;
}
