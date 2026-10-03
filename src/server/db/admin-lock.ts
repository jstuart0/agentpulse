/**
 * Admin lock: serializes admin-count-sensitive writes — role change,
 * disable, enable, reset-password, env-admin promotion, the mode switch, and
 * the admin-service-key list — across both dialects.
 *
 *  - Postgres: one db.transaction(fn), whose first statement (issued on the
 *    transaction handle itself, never on a fresh connection) is
 *    SELECT pg_advisory_xact_lock(<constant>). The xact-scoped variant is
 *    session-scoped to the transaction and releases automatically on commit
 *    or rollback — a crashed holder can't leak the lock past its own
 *    transaction, and a pooled connection returning to the pool never
 *    carries a stale lock with it. The constant is deliberately different
 *    from db/client.ts's own migration-boot advisory lock (0xA9E1A917):
 *    pg_advisory_lock and pg_advisory_xact_lock share one lock-id namespace,
 *    so reusing that id could make a long-held migration lock block an
 *    unrelated admin-lock caller (or vice versa).
 *  - SQLite: a process-level async mutex (SQLite has exactly one writer —
 *    this process), then BEGIN IMMEDIATE ... COMMIT/ROLLBACK on the shared
 *    connection. If an unrelated transaction is already open on that
 *    connection — withTransaction()'s own manual BEGIN/COMMIT has no mutex,
 *    see its header comment — BEGIN IMMEDIATE throws "cannot start a
 *    transaction within a transaction"; this retries with
 *    a doubling delay for a bounded total (about a second) before
 *    surfacing the error, rather than failing the request outright for a
 *    transient overlap. The mutex and the retry solve two different problems: the
 *    mutex serializes concurrent admin-lock callers against each other
 *    (so the second one queues cleanly instead of burning retry attempts
 *    racing the first); the retry covers contention from code outside the
 *    admin lock entirely.
 *
 * Every helper called inside `fn` must take the passed `tx` and issue its
 * statements on it, never call getDb() — a helper that calls getDb() would
 * commit its own write immediately, even if the outer lock's transaction
 * later rolls back (on Postgres; on SQLite the handle is the shared
 * connection either way, so only a code-level check can notice — see
 * admin-lock.test.ts). Postgres also needs the rule for a second reason:
 * the transaction holds one pooled connection, so a statement issued on the
 * pool waits for another, and with a pool of one it waits forever.
 *
 * The general transaction helper (withTransaction) does not take the mutex but
 * does wait for it: while the lock is held or queued it waits for the holders
 * to finish (waitForSqliteAdminLock), and when the lock is free it adds
 * nothing. That removes the clash "cannot start a transaction within a
 * transaction" between a hook event's transaction and a key mint or user
 * change. The remaining limit: the connection is shared, so statements from
 * other in-flight requests that run during a locked body (a plain read or
 * write, not a transaction) execute inside the lock's transaction and are
 * rolled back with it if the body fails. Locked bodies are short and
 * database-only, which keeps that window small.
 *
 * A locked body must not call the general transaction helper at all: it would
 * wait on this lock's own mutex forever, so it throws at once instead.
 *
 * A locked body must not await anything except database calls on `tx`. On
 * SQLite the lock is an open BEGIN IMMEDIATE on the one shared connection,
 * and every other request's statements run inside it until it ends, so a
 * body that waits on a timer, the network or a hash (do those before taking
 * the lock) stretches that window for the whole process; on Postgres it
 * holds a pooled connection and the advisory lock the same way.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { getDb, getSqlite } from "./client.js";

// 0xA9E1A925 — distinct from db/client.ts's migration-boot advisory lock
// (0xA9E1A917). Both exceed the 32-bit signed range but sit well inside the
// 53 bits a JS number holds exactly, and pg_advisory_xact_lock takes a
// bigint, so they pass as plain numbers.
export const PG_ADVISORY_LOCK_ID = 2850603301;

/**
 * How long a SQLite caller keeps retrying BEGIN IMMEDIATE while some other
 * code holds a transaction on the shared connection, in total, before the
 * error surfaces. Bounded so a stuck transaction fails the request rather
 * than hanging it, and long enough (an ingest transaction lasts
 * milliseconds) that ordinary overlap never reaches the caller.
 */
const DEFAULT_SQLITE_RETRY_BUDGET_MS = 1000;
const DEFAULT_SQLITE_RETRY_INITIAL_DELAY_MS = 25;
const SQLITE_RETRY_MAX_DELAY_MS = 200;

/**
 * Set for the duration of a locked body (and everything it awaits), so the
 * general transaction helper can tell it is being called from inside one.
 * Statements of other requests run in their own async context and don't see it.
 */
const insideAdminLock = new AsyncLocalStorage<true>();

/**
 * Throws if called from inside a withAdminLock body: the general transaction
 * helper would wait on the lock's own mutex forever on SQLite (the lock is an
 * open transaction on the one shared connection), and take a second pooled
 * connection on Postgres. A locked body issues its statements on its `tx`.
 */
export function assertNotInsideAdminLock(): void {
	if (insideAdminLock.getStore()) {
		throw new Error(
			"withTransaction was called from inside a withAdminLock body. Issue the statements on the body's own tx instead; the admin lock already is the transaction.",
		);
	}
}

export interface AdminLockOptions {
	/** SQLite only: total time to keep retrying BEGIN IMMEDIATE (default 1000 ms). Tests shorten it. */
	sqliteRetryBudgetMs?: number;
	/** SQLite only: delay before the first retry; doubles each time up to 200 ms (default 25 ms). Tests shorten it. */
	sqliteRetryInitialDelayMs?: number;
}

export async function withAdminLock<T>(
	// biome-ignore lint/suspicious/noExplicitAny: tx type unified in a later schema-extraction pass (same posture as with-transaction.ts)
	fn: (tx: any) => T | Promise<T>,
	opts: AdminLockOptions = {},
): Promise<T> {
	if (config.dialect === "postgres") {
		const db = getDb();
		// biome-ignore lint/suspicious/noExplicitAny: pg adapter shape, same posture as with-transaction.ts
		return await (db as any).transaction(async (tx: any) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(${PG_ADVISORY_LOCK_ID})`);
			return insideAdminLock.run(true, () => fn(tx));
		});
	}

	return withSqliteAdminLock(fn, opts);
}

// ── SQLite: process-level mutex + BEGIN IMMEDIATE with retry ────────────────

let sqliteMutexTail: Promise<void> = Promise.resolve();
/** Callers that hold the mutex or are queued for it. Zero means the lock is free. */
let sqliteLockPending = 0;

/** SQLite only: does any admin-lock caller hold or await the lock right now? */
export function isSqliteAdminLockBusy(): boolean {
	return sqliteLockPending > 0;
}

/**
 * SQLite only: resolves once no admin-lock caller holds or awaits the lock.
 * Call it only when isSqliteAdminLockBusy() said so, so a free lock costs the
 * caller not even a turn; the caller's next synchronous statement (BEGIN)
 * then runs in the same turn as the last check, and the lock can't be taken
 * in between.
 */
export async function waitForSqliteAdminLock(): Promise<void> {
	while (sqliteLockPending > 0) await sqliteMutexTail;
}

/** Standard async-mutex queueing pattern: each acquire() resolves only after every earlier acquire() has released. */
function acquireSqliteAdminMutex(): Promise<() => void> {
	let release: () => void = () => {};
	const waitForRelease = new Promise<void>((resolve) => {
		release = resolve;
	});
	const acquired = sqliteMutexTail.then(() => release);
	sqliteMutexTail = sqliteMutexTail.then(() => waitForRelease);
	return acquired;
}

async function withSqliteAdminLock<T>(
	// biome-ignore lint/suspicious/noExplicitAny: see withAdminLock
	fn: (tx: any) => T | Promise<T>,
	opts: AdminLockOptions,
): Promise<T> {
	sqliteLockPending++;
	const release = await acquireSqliteAdminMutex();
	try {
		return await beginImmediateWithRetry(fn, opts);
	} finally {
		sqliteLockPending--;
		release();
	}
}

async function beginImmediateWithRetry<T>(
	// biome-ignore lint/suspicious/noExplicitAny: see withAdminLock
	fn: (tx: any) => T | Promise<T>,
	opts: AdminLockOptions,
): Promise<T> {
	const budgetMs = opts.sqliteRetryBudgetMs ?? DEFAULT_SQLITE_RETRY_BUDGET_MS;
	let delayMs = opts.sqliteRetryInitialDelayMs ?? DEFAULT_SQLITE_RETRY_INITIAL_DELAY_MS;
	const sqlite = getSqlite();
	const startedAt = Date.now();

	// Retry only the BEGIN. Once it has succeeded the body runs exactly once.
	for (;;) {
		try {
			sqlite.exec("BEGIN IMMEDIATE");
			break;
		} catch (err) {
			const remainingMs = budgetMs - (Date.now() - startedAt);
			if (remainingMs <= 0) throw err;
			await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
			delayMs = Math.min(delayMs * 2, SQLITE_RETRY_MAX_DELAY_MS);
		}
	}

	try {
		const result = await insideAdminLock.run(true, () => fn(getDb()));
		sqlite.exec("COMMIT");
		return result;
	} catch (err) {
		try {
			sqlite.exec("ROLLBACK");
		} catch {
			// ROLLBACK can fail if the connection dropped or BEGIN never took —
			// swallow so the original error surfaces, matching withTransaction.
		}
		throw err;
	}
}
