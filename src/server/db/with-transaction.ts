/**
 * Dialect-aware transaction helper (Phase 1 — Decision 35).
 *
 * # Why this exists
 * bun-sqlite's Drizzle adapter REQUIRES a synchronous callback for correct
 * rollback semantics. Passing an async callback causes the adapter to commit
 * before the callback settles, silently disabling rollback (verified via 7
 * failing rollback tests in Phase 0). The original plan's Decision 16
 * assumption ("portable async transactions work on both adapters") is wrong
 * for bun-sqlite.
 *
 * # Contract
 * Call `withTransaction((tx) => { ... })` everywhere you need a transaction.
 * The helper:
 *   - On the SQLite path: calls db.transaction(fn) using bun-sqlite's Drizzle
 *     adapter. The adapter executes the callback synchronously inside a SQLite
 *     BEGIN/COMMIT/ROLLBACK block and returns the result directly (not a
 *     Promise or a `.sync()`-bearing object — verified at runtime). The
 *     callback MUST use only synchronous tx.* call forms:
 *       tx.insert(...).run()    — not await tx.insert(...)
 *       tx.select(...).all()    — not await tx.select(...)
 *       tx.select(...).get()    — not await tx.select(...).limit(1)
 *     Passing an async fn that resolves after db.transaction() returns would
 *     commit before the async work settles, silently disabling rollback.
 *     ROLLBACK fires when the callback throws synchronously.
 *   - On the Postgres path: calls db.transaction(fn) which natively returns
 *     a Promise and supports async callbacks with rollback on rejection.
 *
 * # Migration note
 * Callers ported from Phase 0's sync-callback pattern should use the sync
 * tx.* API forms inside the callback on the SQLite path:
 *   - `await tx.insert(...)` → `tx.insert(...).run()` (inside withTransaction)
 *   - `await tx.select(...)` → `tx.select(...).all()` or `.get()`
 * Phase 2+ will introduce a true async-capable portable layer; this helper
 * is the Phase 1 bridge that maintains rollback correctness on SQLite while
 * presenting a uniform async interface to callers.
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
import { getDb } from "./client.js";

// biome-ignore lint/suspicious/noExplicitAny: tx type unified in Phase 2a
export async function withTransaction<T>(fn: (tx: any) => T | Promise<T>): Promise<T> {
	const db = getDb();

	if (config.dialect === "sqlite") {
		// bun-sqlite's Drizzle adapter executes db.transaction(fn) synchronously
		// and returns the callback's return value directly (verified at runtime:
		// the result is the value, not a Promise/wrapper). The callback runs inside
		// a BEGIN/COMMIT/ROLLBACK block; ROLLBACK fires when fn throws synchronously.
		//
		// IMPORTANT: fn must call only synchronous tx.* forms:
		//   tx.insert(...).run()   — not await tx.insert(...)
		//   tx.select(...).all()   — not await tx.select(...)
		// Passing an async fn that returns a Promise would cause db.transaction()
		// to return a Promise as the "result", committing it without awaiting
		// resolution — silently disabling rollback.
		// biome-ignore lint/suspicious/noExplicitAny: bun-sqlite adapter shape
		const result = (db as any).transaction(fn) as T;
		// Runtime guard (xander mid-build H2): if a future caller passes an
		// async fn, `result` is the Promise produced by the async fn, NOT the
		// resolved value. The transaction has already COMMITted by the time we
		// see the Promise — rollback is disabled. Throw hard so this fails fast
		// instead of silently corrupting state on the SQLite path.
		if (result instanceof Promise) {
			throw new Error(
				"[withTransaction] Async callback detected on SQLite path. " +
					"bun-sqlite's Drizzle adapter commits before async work settles, " +
					"silently disabling rollback. Use synchronous tx.* forms inside the " +
					"callback (tx.insert(...).run(), tx.select(...).all(), tx.select(...).get()).",
			);
		}
		return Promise.resolve(result);
	}

	// Postgres: drizzle-orm/postgres-js natively supports async transaction
	// callbacks. db.transaction(fn) returns Promise<T>.
	// biome-ignore lint/suspicious/noExplicitAny: pg adapter shape
	return await (db as any).transaction(fn);
}
