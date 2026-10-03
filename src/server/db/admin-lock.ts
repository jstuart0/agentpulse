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
 *  - SQLite: one FIFO queue shared with withTransaction() (the shared
 *    connection holds one transaction at a time), then BEGIN IMMEDIATE ...
 *    COMMIT/ROLLBACK. A caller is released only when the one before it has
 *    committed or rolled back, so no BEGIN is ever issued while another
 *    transaction is open. The BEGIN IMMEDIATE retry with a doubling delay (a
 *    bounded total of about a second) remains for the one thing the queue
 *    can't see: a transaction opened on the connection by code that doesn't use
 *    either helper.
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
 * The general transaction helper (withTransaction) queues on the same FIFO,
 * so a hook event's transaction waits for a key mint or user change and the
 * other way round, and several waiters never start together.
 *
 * Plain statements from other requests (a hook's session or event write, which
 * is not in a transaction) are not gated: the connection is shared, so one that
 * ran during a locked body would execute inside the lock's transaction and be
 * rolled back with it if the body failed, after its request was already
 * answered. So on SQLite a locked body is made unable to be interleaved with:
 *  - the lock first lets the event loop turn once (a macrotask), so every
 *    request chain that is mid-way through a run of already-resolved awaits has
 *    finished before BEGIN IMMEDIATE;
 *  - a body then only awaits database calls, which bun:sqlite answers
 *    synchronously, so its whole run is one microtask drain and no timer, socket
 *    or other request's continuation can start inside it (anything that needs
 *    the network, a hash or a timer is done before the lock is taken);
 *  - a sentinel scheduled on the event loop at BEGIN detects a body that did
 *    yield: in tests that is an error, in production a structured error log.
 *    A deliberate test seam inside a body declares itself with
 *    awaitSeamInsideAdminLock; a test that holds the lock open on purpose passes
 *    sqliteAllowYield.
 * Postgres is unaffected: the body runs on its own pooled connection inside its
 * own transaction.
 *
 * A locked body must not call the general transaction helper at all: it would
 * wait on this lock's own queue slot forever, so it throws at once instead.
 *
 * A locked body must not await anything except database calls on `tx`. On
 * Postgres a body that waits on a timer, the network or a hash holds a pooled
 * connection and the advisory lock for that long, so do those before taking
 * the lock there too.
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
interface LockedBodyContext {
	/** Set once a declared test seam has run in this body: the sentinel then proves nothing. */
	yieldPermitted: boolean;
}
const insideAdminLock = new AsyncLocalStorage<LockedBodyContext>();

/**
 * Awaits a test seam from inside a locked body and marks the body as one that
 * is allowed to yield. A no-op (returns undefined) when no hook is installed,
 * so production bodies stay yield-free.
 */
export async function awaitSeamInsideAdminLock<Step>(
	hook: ((step: Step) => Promise<void>) | null | undefined,
	step: Step,
): Promise<void> {
	if (!hook) return;
	const context = insideAdminLock.getStore();
	if (context) context.yieldPermitted = true;
	await hook(step);
}

/**
 * Throws if called from inside a withAdminLock body: the general transaction
 * helper would wait on its own queue slot forever on SQLite (the lock is an
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
	/** SQLite only: the body may wait on the event loop. For tests that hold the lock open on purpose; no production caller sets it. */
	sqliteAllowYield?: boolean;
}

/** Thrown in tests when a locked body on SQLite yielded to the event loop. */
export class AdminLockYieldError extends Error {
	constructor(options?: { cause?: unknown }) {
		super(
			"A withAdminLock body yielded to the event loop on SQLite: other requests' statements can land inside the lock's transaction and be rolled back with it. Do timers, network, hashing and other async work before taking the lock.",
			options,
		);
		this.name = "AdminLockYieldError";
	}
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
			return insideAdminLock.run({ yieldPermitted: true }, () => fn(tx));
		});
	}

	return withSqliteAdminLock(fn, opts);
}

// ── SQLite: one queue for every transaction on the shared connection ────────

let sqliteQueueTail: Promise<void> = Promise.resolve();

/**
 * Set while a transaction holds the SQLite queue slot (withTransaction's, and
 * the admin lock's own). A transaction asked for from inside one would wait for
 * its own slot forever, so it throws instead. `open` goes false at the end so
 * work detached from the transaction (not awaited by it) isn't refused later.
 */
interface SqliteTransactionContext {
	open: boolean;
}
const insideSqliteTransaction = new AsyncLocalStorage<SqliteTransactionContext>();

/**
 * SQLite only: waits for every earlier transaction to end, runs `fn` as the
 * only open transaction on the connection, then lets the next one in. FIFO:
 * each caller is released only after the one before it has finished.
 */
export async function runInSqliteTransactionSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (insideSqliteTransaction.getStore()?.open) {
		throw new Error(
			"A transaction was started from inside another one on SQLite. Issue the statements on the open transaction's tx instead; one connection holds one transaction at a time.",
		);
	}
	let release: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const turn = sqliteQueueTail;
	sqliteQueueTail = turn.then(() => done);
	await turn;
	const context: SqliteTransactionContext = { open: true };
	try {
		return await insideSqliteTransaction.run(context, fn);
	} finally {
		context.open = false;
		release();
	}
}

async function withSqliteAdminLock<T>(
	// biome-ignore lint/suspicious/noExplicitAny: see withAdminLock
	fn: (tx: any) => T | Promise<T>,
	opts: AdminLockOptions,
): Promise<T> {
	return runInSqliteTransactionSlot(() => beginImmediateWithRetry(fn, opts));
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

	// Let the event loop turn once before taking the transaction: any request
	// chain still working through already-resolved awaits finishes now, outside
	// the lock, rather than half way through the body.
	await new Promise<void>((resolve) => setImmediate(resolve));

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

	let yielded = false;
	const sentinel = setImmediate(() => {
		yielded = true;
	});
	const context: LockedBodyContext = { yieldPermitted: opts.sqliteAllowYield === true };
	try {
		const result = await insideAdminLock.run(context, () => fn(getDb()));
		clearImmediate(sentinel);
		reportYield(yielded, context);
		sqlite.exec("COMMIT");
		return result;
	} catch (err) {
		clearImmediate(sentinel);
		try {
			sqlite.exec("ROLLBACK");
		} catch {
			// ROLLBACK can fail if the connection dropped or BEGIN never took —
			// swallow so the original error surfaces, matching withTransaction.
		}
		if (err instanceof AdminLockYieldError) throw err;
		reportYield(yielded, context, err);
		throw err;
	}
}

/** A yield is an error in tests and a structured log line in production, where the body's own outcome stands. */
function reportYield(yielded: boolean, context: LockedBodyContext, cause?: unknown): void {
	if (!yielded || context.yieldPermitted) return;
	if (process.env.NODE_ENV === "test") throw new AdminLockYieldError({ cause });
	console.error(JSON.stringify({ kind: "admin_lock_body_yielded", level: "error" }));
}
