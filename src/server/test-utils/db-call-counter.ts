/**
 * Shared test helper: count Drizzle statement calls issued during a block
 * of code, independent of which dialect is active.
 *
 * getDb() returns the same long-lived Drizzle instance on every call, so
 * spying on its four statement-builder entry points (select/insert/update/
 * delete) for the duration of one callback gives a stable, dialect-portable
 * proxy for "how many DB statements did this path issue" — the same count
 * whether the connection underneath is bun:sqlite or postgres-js.
 *
 * Transaction handle, both dialects: withTransaction()'s callback receives a
 * `tx` object to issue statements on. On SQLite, withTransaction passes the
 * same object getDb() returns, so spying on `db` already catches everything
 * a transaction does. On Postgres, drizzle-orm/postgres-js's db.transaction(fn)
 * hands the callback a genuinely distinct transaction-scoped object — a
 * statement issued as `tx.select(...)` inside that callback never touches
 * `db.select`, so the spies above miss it entirely. Any code path that opens
 * a transaction on Postgres (event-processor.ts's permission-wait update,
 * the admin lock's advisory-lock transaction, etc.) was undercounted by
 * exactly the number of statements it issued on `tx`.
 *
 * Fixed by wrapping db.transaction itself for the duration of the counted
 * block: when the real transaction() creates a `tx` that isn't `db` (the
 * Postgres case), this installs the same spies on `tx` before invoking
 * the caller's transaction callback, waits for that (async) callback to
 * settle, and folds the counts into the total — reading them any earlier
 * would miss every statement issued after the callback's first await.
 * On SQLite this is a no-op (tx === db, so the extra spies would double
 * count — guarded against by the `tx !== db` check).
 *
 * `execute` (raw SQL, Postgres adapter only) is spied alongside the four
 * query builders, on the db and on a transaction handle, so the admin
 * lock's advisory-lock statement and any other raw statement are counted.
 */
import { spyOn } from "bun:test";
import { getDb } from "../db/client.js";

// biome-ignore lint/suspicious/noExplicitAny: statement-builder surface only, dialect-portable
type StatementHandle = any;

/** The statement entry points a handle exposes; raw SQL is `all` on the SQLite adapter and `execute` on the Postgres one. */
const STATEMENT_METHODS = ["select", "insert", "update", "delete", "execute", "all"] as const;

function spyOnStatements(handle: StatementHandle) {
	return STATEMENT_METHODS.filter((method) => typeof handle[method] === "function").map((method) =>
		spyOn(handle, method),
	);
}

function sumCalls(spies: ReturnType<typeof spyOnStatements>): number {
	return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

export async function countDbCalls(fn: () => Promise<void>): Promise<number> {
	const db = getDb();
	const spies = spyOnStatements(db);

	let txExtra = 0;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable transaction entry point
	const dbWithTransaction = db as any;
	const hasTransaction = typeof dbWithTransaction.transaction === "function";
	const originalTransaction = hasTransaction
		? dbWithTransaction.transaction.bind(dbWithTransaction)
		: null;
	const transactionSpy = hasTransaction
		? spyOn(dbWithTransaction, "transaction").mockImplementation(
				// biome-ignore lint/suspicious/noExplicitAny: forwards whatever db.transaction itself accepts
				(callback: (tx: StatementHandle) => unknown, ...rest: any[]) => {
					return originalTransaction(
						async (tx: StatementHandle) => {
							if (tx === db) {
								// SQLite: the "transaction" handle is the same object
								// already being spied on above — nothing extra to do.
								return callback(tx);
							}
							const txSpies = spyOnStatements(tx);
							try {
								return await callback(tx);
							} finally {
								txExtra += sumCalls(txSpies);
								for (const spy of txSpies) spy.mockRestore();
							}
						},
						...rest,
					);
				},
			)
		: null;

	try {
		await fn();
		return sumCalls(spies) + txExtra;
	} finally {
		for (const spy of spies) spy.mockRestore();
		transactionSpy?.mockRestore();
	}
}
