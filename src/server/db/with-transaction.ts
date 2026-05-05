/**
 * Dialect-aware transaction helper (Phase 1 — Decision 35, revised Phase 8).
 *
 * # Why this exists
 * bun-sqlite's Drizzle adapter calls db.transaction(fn) synchronously. When
 * an async callback is passed, the adapter commits before the Promise resolves,
 * silently disabling rollback (verified via 7 failing rollback tests in Phase 0).
 * The original Phase 1 bridge kept async off the SQLite path; Phase 8 enables
 * async callbacks on SQLite by using a manual BEGIN/COMMIT/ROLLBACK via the
 * raw bun:sqlite handle.
 *
 * # Contract
 * Call `await withTransaction((tx) => { ... })` everywhere you need a transaction.
 * The helper:
 *   - On the SQLite path: issues BEGIN, awaits the callback, issues COMMIT on
 *     success or ROLLBACK on throw. The callback receives the Drizzle db handle
 *     as `tx` (same object as getDb()). Use `await tx.insert(...)` etc. — Drizzle's
 *     bun-sqlite ops are synchronous under the hood, so the awaits are no-ops, but
 *     the form is dialect-portable. SQLite serialises connections so concurrent
 *     BEGIN/COMMIT pairs are safe.
 *   - On the Postgres path: calls db.transaction(fn) which natively returns a
 *     Promise and supports async callbacks with rollback on rejection.
 *
 * # Type annotation on `tx`
 * The tx parameter is typed as `any` in Phase 1. The precise types are
 * `SQLiteTransaction<'sync', void, ...>` (bun-sqlite) and
 * `PgTransaction<PostgresJsQueryResultHKT, ...>` (postgres-js). Unifying
 * them into a single generic requires Phase 2a's full schema extraction.
 * Using `any` here is intentional and contained — callers get type safety
 * from the table schemas they pass into tx.insert/select/update/delete.
 */
import { config } from "../config.js";
import { getDb, getSqlite } from "./client.js";

// biome-ignore lint/suspicious/noExplicitAny: tx type unified in Phase 2a
export async function withTransaction<T>(fn: (tx: any) => T | Promise<T>): Promise<T> {
	const db = getDb();

	if (config.dialect === "sqlite") {
		// Manual BEGIN/COMMIT/ROLLBACK via the raw bun:sqlite handle so that async
		// callbacks are safe. When fn is async, await resolves the Promise before
		// COMMIT fires — rollback semantics are preserved on rejection.
		//
		// Why not db.transaction(fn)?
		//   bun-sqlite's Drizzle adapter executes db.transaction(fn) synchronously;
		//   if fn is async the adapter sees a Promise-returning fn and commits
		//   immediately (before the Promise resolves), silently disabling rollback.
		//   Using raw exec() sidesteps the adapter's sync-only assumption.
		//
		// Why pass `db` (the Drizzle handle) as tx instead of the raw sqlite handle?
		//   Callers use Drizzle query-builder forms (tx.insert, tx.select, etc.).
		//   Those forms work against the shared Drizzle instance; they still land on
		//   the same underlying SQLite connection, which SQLite serialises, so all
		//   ops are within the BEGIN/COMMIT block.
		const sqlite = getSqlite();
		sqlite.exec("BEGIN");
		try {
			const result = await fn(db);
			sqlite.exec("COMMIT");
			return result;
		} catch (err) {
			try {
				sqlite.exec("ROLLBACK");
			} catch {
				// ROLLBACK can fail if the connection dropped or BEGIN was never reached.
				// Swallow to surface the original error instead.
			}
			throw err;
		}
	}

	// Postgres: drizzle-orm/postgres-js natively supports async transaction
	// callbacks. db.transaction(fn) returns Promise<T>.
	// biome-ignore lint/suspicious/noExplicitAny: pg adapter shape
	return await (db as any).transaction(fn);
}
