/**
 * Event retention (AGEN-24).
 *
 * Deletes rows from `events` older than the operator-configured
 * `eventsRetentionDays` setting, in bounded batches, on a periodic timer.
 *
 * ## Data-safety rule (binding)
 *
 * Retention is OFF unless the operator explicitly sets `eventsRetentionDays`
 * to a positive integer via Settings (PUT /api/v1/settings). Unset, `0`,
 * negative, or non-numeric values all mean "disabled" — no row is ever
 * deleted. This is deliberate: the setting predates this enforcement (it has
 * existed since before AGEN-24 with no enforcement behind it), so an
 * existing install upgrading to this release must not suddenly start losing
 * data because a UI placeholder value looked like a configured default.
 *
 * ## What is deleted, what is kept
 *
 *  - Deleted: `events` rows with `created_at` older than the cutoff
 *    (`now - eventsRetentionDays days`), in batches of `BATCH_SIZE`.
 *  - Never touched: the `sessions` row itself, and everything denormalized
 *    onto it (status, isWorking, current_task, plan_summary, and
 *    `metadata.permissionWait`). Session state is read from the `sessions`
 *    row, not reconstructed by scanning `events` — see
 *    applyPermissionWaitTransition in event-processor.ts — so purging old
 *    event rows never affects a session's current state or an outstanding
 *    permission-wait.
 *  - No per-session floor: unlike a session delete (which is an explicit
 *    operator action), a retention pass does not keep the "latest N events"
 *    for an old-but-still-open session. The operator picked a day count;
 *    every event older than that cutoff is fair game, active session or
 *    not. This keeps the implementation simple and the behavior easy to
 *    reason about: "days" means days, not "days, unless the session is
 *    still open."
 *
 * Deleting from `events` fires the existing SQLite triggers
 * (`trg_events_ad_fts`, `trg_events_ad_embeddings`) so `search_events_fts`
 * and `event_embeddings` stay consistent automatically — see
 * db/client.ts's FTS/embeddings bootstrap. Postgres has no shadow FTS index
 * to keep in sync (ILIKE backend queries `events` directly).
 *
 * ## Concurrency
 *
 * SQLite: this deployment is documented single-replica (see CLAUDE.md), and
 * each batch is a single independent `DELETE` statement (no wrapping
 * transaction), so a pass never holds the one SQLite writer connection for
 * longer than one batch — ingest writes interleave between batches.
 *
 * Postgres (multi-replica capable): the whole pass runs inside one
 * transaction guarded by `pg_try_advisory_xact_lock` — non-blocking, and
 * automatically released at commit/rollback, so it needs no dedicated
 * connection or explicit unlock (contrast with the migration boot lock in
 * db/client.ts, which is session-scoped and does need one). If another
 * replica already holds the lock, this pass no-ops for this tick; the next
 * scheduled tick tries again. Row-level DELETE locks don't contend with
 * concurrent INSERTs on unrelated rows, so ingest is not blocked while the
 * transaction is open.
 */
import { type SQL, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import { getDb, getSqlite } from "../db/client.js";
import { events, settings } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { toDbTimestamp } from "./util/db-time.js";

export const EVENTS_RETENTION_DAYS_KEY = "eventsRetentionDays";

const DEFAULT_BATCH_SIZE = 5_000;
// Mutable so tests can force multiple small batches without waiting to
// insert 5,000+ rows. Production code never calls the setter.
let batchSize = DEFAULT_BATCH_SIZE;

/** Override the batch size — test-only. Pass null to restore the default. */
export function _setRetentionBatchSizeForTest(size: number | null): void {
	batchSize = size ?? DEFAULT_BATCH_SIZE;
}

// Safety cap: 200 batches x DEFAULT_BATCH_SIZE rows = 1,000,000 rows per
// pass at the production batch size. A backlog larger than that (e.g. the
// first pass after enabling retention on a very old install) is finished
// across subsequent scheduled ticks rather than running one unbounded pass.
const MAX_BATCHES_PER_PASS = 200;

// pg_try_advisory_xact_lock id. Derived from ASCII "RETN" (0x52 0x45 0x54
// 0x4E), distinct from the migration boot lock's 0xA9E1A917 in db/client.ts
// so the two never collide.
const PG_RETENTION_LOCK_ID = 0x5245544e; // 1_380_275_022

export interface RetentionRunResult {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	rowsDeleted: number;
	batches: number;
	retentionDays: number;
	/** true when the setting was unset/0/invalid — the pass did nothing. */
	disabled: boolean;
	/** Set when a Postgres replica skipped because another replica held the lock. */
	skippedReason?: "lock_held_elsewhere" | "already_running";
}

export interface RetentionStatus {
	lastRun: RetentionRunResult | null;
	nextRunAt: string | null;
}

let lastRun: RetentionRunResult | null = null;
let nextRunAt: string | null = null;
let passInProgress = false;
let scheduledInterval: ReturnType<typeof setInterval> | null = null;

/** Current retention status for /api/v1/health. */
export function getRetentionStatus(): RetentionStatus {
	return { lastRun, nextRunAt };
}

/** Reset all module state — test-only. */
export function _resetRetentionStateForTest(): void {
	lastRun = null;
	nextRunAt = null;
	passInProgress = false;
	if (scheduledInterval !== null) {
		clearInterval(scheduledInterval);
		scheduledInterval = null;
	}
}

async function readRetentionDays(): Promise<number> {
	const [row] = await getDb()
		.select()
		.from(settings)
		.where(eq(settings.key, EVENTS_RETENTION_DAYS_KEY))
		.limit(1);
	const raw = row?.value;
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.floor(n);
}

/**
 * Delete up to BATCH_SIZE rows older than `cutoff` using `db` (either the
 * shared pool for SQLite, or the current transaction handle for Postgres —
 * see runRetentionPass). Returns the number of rows deleted.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function deleteBatch(db: any, cutoff: string): Promise<number> {
	const rows: Array<{ id: number }> = await db
		.select({ id: events.id })
		.from(events)
		.where(lt(events.createdAt, cutoff))
		.orderBy(asc(events.id))
		.limit(batchSize);
	if (rows.length === 0) return 0;
	const ids = rows.map((r) => r.id);
	await db.delete(events).where(inArray(events.id, ids));
	return rows.length;
}

async function runBatchLoop(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle
	db: any,
	cutoff: string,
): Promise<{ rowsDeleted: number; batches: number }> {
	let rowsDeleted = 0;
	let batches = 0;
	for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
		const deleted = await deleteBatch(db, cutoff);
		if (deleted === 0) break;
		rowsDeleted += deleted;
		batches++;
		// Yield to the event loop between batches so ingest requests (and any
		// other pending work) interleave rather than waiting behind the whole
		// pass. On Postgres this doesn't release the transaction's connection,
		// but row-level DELETE locks don't contend with unrelated INSERTs, so
		// concurrent ingest on other connections is unaffected either way.
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return { rowsDeleted, batches };
}

/**
 * SQLite space reclaim after a pass that deleted rows. If the database was
 * created with `PRAGMA auto_vacuum = INCREMENTAL`, freed pages can be
 * returned to the OS without a blocking full VACUUM. Existing installs are
 * created with SQLite's default `auto_vacuum = NONE` (see db/client.ts's
 * boot PRAGMAs — auto_vacuum is not among them), so for those, freed space
 * stays in the file until an operator runs a one-time `VACUUM` during a
 * maintenance window (see deploy/k8s/README.md). We never run a blocking
 * full VACUUM automatically here.
 */
function maybeIncrementalVacuum(): void {
	try {
		const sqlite = getSqlite();
		const row = sqlite.prepare("PRAGMA auto_vacuum").get() as Record<string, number> | undefined;
		const mode = row ? Object.values(row)[0] : undefined;
		if (mode === 2) {
			sqlite.exec("PRAGMA incremental_vacuum;");
		}
	} catch (err) {
		console.error("[retention] incremental_vacuum check failed:", err);
	}
}

async function tryAdvisoryXactLock(
	// biome-ignore lint/suspicious/noExplicitAny: postgres-js transaction handle
	tx: any,
): Promise<boolean> {
	const query: SQL = sql`SELECT pg_try_advisory_xact_lock(${PG_RETENTION_LOCK_ID}) AS locked`;
	const result: Array<{ locked: boolean }> = await tx.execute(query);
	return Boolean(result?.[0]?.locked);
}

/**
 * Run one retention pass. Safe to call directly from tests — does not
 * depend on the interval scheduler.
 */
export async function runRetentionPass(now: Date = new Date()): Promise<RetentionRunResult> {
	// Set the guard synchronously — before any `await` — so two back-to-back
	// (unawaited) calls can't both observe passInProgress === false. JS only
	// yields to another call at an `await` point, so this check-and-set is
	// atomic with respect to any other invocation of this function.
	if (passInProgress) {
		const result: RetentionRunResult = {
			startedAt: now.toISOString(),
			finishedAt: now.toISOString(),
			durationMs: 0,
			rowsDeleted: 0,
			batches: 0,
			retentionDays: 0,
			disabled: false,
			skippedReason: "already_running",
		};
		return result;
	}
	passInProgress = true;
	const startedAtMs = Date.now();

	try {
		const days = await readRetentionDays();
		if (days <= 0) {
			lastRun = {
				startedAt: now.toISOString(),
				finishedAt: now.toISOString(),
				durationMs: 0,
				rowsDeleted: 0,
				batches: 0,
				retentionDays: 0,
				disabled: true,
			};
			return lastRun;
		}

		const cutoff = toDbTimestamp(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));

		let rowsDeleted = 0;
		let batches = 0;
		let skippedReason: RetentionRunResult["skippedReason"];

		if (config.dialect === "postgres") {
			await withTransaction(async (tx) => {
				const acquired = await tryAdvisoryXactLock(tx);
				if (!acquired) {
					skippedReason = "lock_held_elsewhere";
					return;
				}
				const result = await runBatchLoop(tx, cutoff);
				rowsDeleted = result.rowsDeleted;
				batches = result.batches;
			});
		} else {
			const result = await runBatchLoop(getDb(), cutoff);
			rowsDeleted = result.rowsDeleted;
			batches = result.batches;
			if (rowsDeleted > 0) {
				maybeIncrementalVacuum();
			}
		}

		const finishedAtMs = Date.now();
		lastRun = {
			startedAt: new Date(startedAtMs).toISOString(),
			finishedAt: new Date(finishedAtMs).toISOString(),
			durationMs: finishedAtMs - startedAtMs,
			rowsDeleted,
			batches,
			retentionDays: days,
			disabled: false,
			...(skippedReason ? { skippedReason } : {}),
		};
		return lastRun;
	} finally {
		passInProgress = false;
	}
}

/**
 * Start the periodic retention timer. Idempotent — calling twice clears the
 * previous interval first (mirrors the single-instance assumption the rest
 * of index.ts's periodic jobs make; see WatcherRunner.start()).
 */
export function scheduleRetentionInterval(intervalMs: number): void {
	if (scheduledInterval !== null) clearInterval(scheduledInterval);
	nextRunAt = new Date(Date.now() + intervalMs).toISOString();
	scheduledInterval = setInterval(() => {
		nextRunAt = new Date(Date.now() + intervalMs).toISOString();
		void runRetentionPass().catch((err) => {
			console.error("[retention] pass failed:", err);
		});
	}, intervalMs);
}
