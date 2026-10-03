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

// ── jsonExtractJson ───────────────────────────────────────────────────────────

/**
 * Returns a SQL expression that extracts a top-level JSON field as JSON TEXT:
 * the value as it would be written in a JSON document, so a string value keeps
 * its quotes and an object stays an object. A caller that parses the text gets
 * exactly the value `JSON.parse` of the whole column would have given at that
 * key, which `jsonExtractText` cannot promise (it unquotes strings, so the
 * text `{"a":1}` could be an object or a string holding that text). A missing
 * key is SQL NULL on Postgres and the text `null` on SQLite; a JSON null is
 * the text `null` on both, so treat NULL and `null` alike.
 *
 * Same path rule as `jsonExtractText`: `$.fieldName`, one level.
 *
 *   SQLite:   json_quote(json_extract(<col>, <path>))
 *   Postgres: ((<col>::json)-><fieldName>)::text
 */
export function jsonExtractJson(col: AnyColumn | SQLWrapper, path: string): SQL {
	const PATH_RE = /^\$\.[a-zA-Z_][a-zA-Z0-9_]*$/;
	if (!PATH_RE.test(path)) {
		throw new Error(`jsonExtractJson: path must match $.fieldName (got: ${JSON.stringify(path)})`);
	}
	if (config.dialect === "postgres") {
		return sql`((${col as SQL}::json)->${path.slice(2)})::text`;
	}
	return sql`json_quote(json_extract(${col as SQL}, ${path}))`;
}

// ── jsonReadable ──────────────────────────────────────────────────────────────

/**
 * A SQL condition that is true when extracting a key from the JSON column is
 * safe, so a statement that reads one key from every row can skip a row it
 * cannot read instead of failing for all of them.
 *
 *   SQLite:   the column's text is valid JSON (`json_valid`); the column is
 *             plain text, so anything can be in it.
 *   Postgres: the column is `json`, which is stored verbatim, so a document
 *             with a NUL (`\u0000`) or a surrogate-range escape can be stored
 *             but not read back by key. The test is on the text of the
 *             escape: any such escape counts, including a valid surrogate pair
 *             and a backslash followed by that text as data. The app's own
 *             writer never produces the first and writes the second as the
 *             character, so this errs only toward "unreadable".
 */
export function jsonReadable(col: AnyColumn | SQLWrapper): SQL {
	if (config.dialect === "postgres") {
		return sql`CAST(${col as SQL} AS text) !~ ${"\\\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})"}`;
	}
	return sql`json_valid(${col as SQL})`;
}

// ── LIKE metacharacter escaping ───────────────────────────────────────────────

/**
 * Escapes `%`, `_`, and the escape character itself (`\`) in a user-supplied
 * LIKE/ILIKE fragment so it matches literally once wrapped in wildcards —
 * e.g. a search for `100%` must match the literal string `100%`, not "100
 * followed by anything". Backslash is escaped FIRST so a pre-existing
 * backslash in the input can't be mistaken for one this function added.
 * Every caller that builds a pattern below pairs this with an explicit
 * `ESCAPE '\'` clause.
 */
function escapeLikeMetacharacters(input: string): string {
	return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ── likeStartsWith ────────────────────────────────────────────────────────────

/**
 * Returns a SQL LIKE / ILIKE fragment that matches values starting with
 * `prefix`. The `%` wildcard is appended at this layer (not by the caller);
 * any `%`/`_`/`\` already in `prefix` is escaped so it matches literally,
 * and the full pattern is passed as a bound parameter.
 *
 *   SQLite:   <col> LIKE  '<prefix>%' ESCAPE '\'
 *   Postgres: <col> ILIKE '<prefix>%' ESCAPE '\'
 */
export function likeStartsWith(col: AnyColumn | SQLWrapper, prefix: string): SQL {
	const pattern = `${escapeLikeMetacharacters(prefix)}%`;
	if (config.dialect === "postgres") {
		return sql`${col as SQL} ILIKE ${pattern} ESCAPE '\\'`;
	}
	return sql`${col as SQL} LIKE ${pattern} ESCAPE '\\'`;
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

// ── isStatementTimeoutError ───────────────────────────────────────────────────

/**
 * Returns true when `err` represents a statement canceled by
 * `statement_timeout` on Postgres: `error.code === '57014'` (SQLSTATE
 * query_canceled). Postgres-only — SQLite has no statement-timeout
 * concept, so this always returns false there.
 *
 * Used by `PostgresSearchBackend`'s two-plan `searchEvents` strategy
 * (percy AGEN-27 review, TB26) to detect Plan A's own deliberate
 * `SET LOCAL statement_timeout` firing so it can fall back to Plan B —
 * NOT a generic "swallow any timeout" helper. Any other error (including
 * a statement_timeout set by something *other* than Plan A's own guard,
 * a lock_timeout, or an idle_in_transaction_session_timeout — all
 * distinct SQLSTATEs) must propagate unchanged.
 */
export function isStatementTimeoutError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;
	if (obj.code === "57014") return true;
	// Defense in depth, mirroring isUniqueViolationError: this path runs the
	// raw postgres-js client directly (not through Drizzle's db.execute()),
	// so today the error is never Drizzle-wrapped — but check one level of
	// .cause anyway in case that changes.
	const cause = obj.cause;
	if (cause && typeof cause === "object" && (cause as Record<string, unknown>).code === "57014") {
		return true;
	}
	return false;
}

// ── isAppIsoTimestamp ────────────────────────────────────────────────────────

/**
 * Returns a SQL predicate that is true only when `col` holds exactly the
 * ISO-with-milliseconds-and-Z shape `new Date().toISOString()` writes
 * (e.g. "2026-10-01T09:00:00.000Z") — the one shape every app-side
 * timestamp write actually produces. NULL input evaluates to NULL (falsy),
 * same as any other SQL comparison against NULL.
 *
 * A plain text `>=` comparison between two stored-timestamp columns is only
 * safe to use as a SQL-side shortcut for "a >= b" when BOTH sides are this
 * exact shape — a legacy SQLite bare value ("2026-10-01 09:00:00", no "T",
 * no "Z") or a Postgres offset value ("2026-10-01 09:00:00+00") sorts
 * lexically against an ISO value by the "T"/" " byte at the same position,
 * not by actual time, and can disagree with parseStoredTimestamp's answer.
 * Gate any such shortcut on this predicate for every column it compares;
 * when it's false, keep the row as a candidate and let the classifier
 * (which parses properly) decide, rather than trusting the SQL text
 * comparison.
 *
 *   SQLite:   <col> GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
 *   Postgres: <col> ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 */
export function isAppIsoTimestamp(col: AnyColumn | SQLWrapper): SQL {
	if (config.dialect === "postgres") {
		return sql`${col as SQL} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'`;
	}
	return sql`${col as SQL} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`;
}

// ── likeContains ─────────────────────────────────────────────────────────────

/**
 * Returns a SQL LIKE / ILIKE fragment that matches values containing
 * `fragment` anywhere. Both `%` boundaries are appended at this layer; any
 * `%`/`_`/`\` already in `fragment` is escaped so it matches literally
 * (e.g. a search for the literal string `100%` doesn't become "100
 * followed by anything"), and the full pattern is passed as a bound
 * parameter.
 *
 *   SQLite:   <col> LIKE  '%<fragment>%' ESCAPE '\'
 *   Postgres: <col> ILIKE '%<fragment>%' ESCAPE '\'
 */
export function likeContains(col: AnyColumn | SQLWrapper, fragment: string): SQL {
	const pattern = `%${escapeLikeMetacharacters(fragment)}%`;
	if (config.dialect === "postgres") {
		return sql`${col as SQL} ILIKE ${pattern} ESCAPE '\\'`;
	}
	return sql`${col as SQL} LIKE ${pattern} ESCAPE '\\'`;
}
