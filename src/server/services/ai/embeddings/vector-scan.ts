// SQLite-only, like the table it reads (pgvector is a follow-up).

import { config } from "../../../config.js";
import { getSqlite } from "../../../db/client.js";
import { parseDbTimestamp } from "../../util/db-time.js";
import { cosineSimilarity } from "./types.js";

/**
 * Bounded, paced scan of `event_embeddings` for one query vector.
 *
 * The first version of the Ask path read every stored vector into memory in
 * one synchronous statement (164,349 rows x 4096 dims, about 2.7 GB, a
 * multi-second event-loop block). This scan holds no memory and does no
 * synchronous work in proportion to the table:
 *
 *  - It reads newest-first in keyset chunks of at most 256 KiB (16 rows at
 *    4096 dims), each served by `idx_event_embeddings_model_dim_event` (named
 *    with INDEXED BY, so a missing index is an error rather than a silent
 *    table scan), so rows examined equal rows returned.
 *  - A LEFT JOIN plus CASE means an orphan vector (no `events` row) costs a
 *    row but no blob read, and a stale-model suffix never enters the seek.
 *  - It stops at a row budget or a time budget and reports which.
 *  - Between chunks it yields with `setImmediate` (a microtask yield starves
 *    I/O; `setTimeout(0)` costs a timer-wheel turn per chunk), and one global
 *    pacer sleeps off each chunk's CPU debt so that all scans in the process
 *    together use at most `config.vectorScanCpuShare` of CPU.
 */

/** Cosine below this is noise on retrieval-trained embeddings. */
const SIMILARITY_FLOOR = 0.4;
const CHUNK_BYTES = 262_144;
const MAX_CHUNK_ROWS = 256;
/** A sleep shorter than this costs more in timer overhead than it saves. */
const MIN_PAYABLE_DEBT_MS = 2;
const FIRST_EVENT_ID_BOUND = Number.MAX_SAFE_INTEGER;
const LOGGED_ERROR_CHARS = 200;

const SCAN_SQL = `SELECT v.event_id AS eventId,
		CASE WHEN e.session_id IS NOT NULL THEN v.vector END AS vector,
		e.session_id AS sessionId
	FROM event_embeddings v INDEXED BY idx_event_embeddings_model_dim_event
	LEFT JOIN events e ON e.id = v.event_id
	WHERE v.model = ? AND v.dim = ? AND v.event_id < ?
	ORDER BY v.event_id DESC
	LIMIT ?`;

export type VectorScanStopReason = "exhausted" | "row_budget" | "time_budget";
export type VectorScanIndexState = "ok" | "missing" | "unknown";

export interface SessionSimilarity {
	max: number;
	count: number;
}

export interface VectorScanStats {
	model: string;
	dim: number;
	/** Rows the statements returned (scored plus skipped). */
	returned: number;
	scored: number;
	/** Orphans and rows whose blob isn't exactly dim x 4 bytes. */
	skipped: number;
	statements: number;
	maxRowsPerStatement: number;
	truncated: boolean;
	stopReason: VectorScanStopReason;
	ms: number;
	busyMs: number;
	/** Time spent asleep paying CPU debt, or waiting on another scan's sleep. */
	sleptMs: number;
	/** The longest synchronous slice: one chunk's read and scoring. */
	maxSliceMs: number;
	/** The oldest covered event (one with an `events` row), or null when none was reached. */
	oldestEventId: number | null;
	oldestEventAt: string | null;
}

export interface VectorScanResult {
	perSession: Map<string, SessionSimilarity>;
	stats: VectorScanStats;
}

interface ScanClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

const realClock: ScanClock = {
	now: () => performance.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let clock: ScanClock = realClock;
let lastStats: VectorScanStats | null = null;
let indexState: VectorScanIndexState = "unknown";
const loggedOnce = new Set<string>();

// The global pacer. `debtMs` is CPU time owed to the rest of the process;
// `sleeping` is the one sleep that pays it, which every other scan awaits.
let debtMs = 0;
let sleeping: Promise<void> | null = null;
let abortSleep: (() => void) | null = null;
let pacerGeneration = 0;

function logOnce(key: string, fields: Record<string, unknown>): void {
	if (loggedOnce.has(key)) return;
	loggedOnce.add(key);
	console.log(JSON.stringify(fields));
}

function chargeDebt(busyMs: number): void {
	const share = config.vectorScanCpuShare;
	if (share >= 1) return;
	debtMs += (busyMs * (1 - share)) / share;
}

/** Sleeps off the whole debt; a shortfall (the timer firing early) goes back, an overshoot earns nothing. */
function startPayingDebt(): Promise<void> {
	const pay = debtMs;
	debtMs = 0;
	const generation = pacerGeneration;
	const startedAt = clock.now();
	const aborted = new Promise<void>((resolve) => {
		abortSleep = resolve;
	});
	const sleep = Promise.race([clock.sleep(pay), aborted]).finally(() => {
		if (generation !== pacerGeneration) return;
		debtMs += Math.max(0, pay - (clock.now() - startedAt));
		sleeping = null;
		abortSleep = null;
	});
	sleeping = sleep;
	return sleep;
}

interface TurnGate {
	/** Whether this scan has yielded to the event loop for this chunk. */
	yielded: boolean;
	/** Whether this scan has already slept off the debt for this chunk. */
	paid: boolean;
	/** Time spent asleep or waiting on another scan's sleep. */
	waitedMs: number;
}

function timed(gate: TurnGate, startWait: () => Promise<void>): Promise<void> {
	const startedWaiting = clock.now();
	return startWait().then(() => {
		gate.waitedMs += clock.now() - startedWaiting;
	});
}

/**
 * What a scan must wait for before it may run its next chunk, or null when
 * it may run it now. The caller loops `await` until this returns null and
 * runs the chunk with no await in between: that is what guarantees no scan
 * issues a statement while another is asleep (a scan that had already been
 * cleared could otherwise run its chunk inside a sleep another scan began
 * a microtask later).
 */
function nextWait(gate: TurnGate): Promise<void> | null {
	if (sleeping) {
		const inFlight = sleeping;
		return timed(gate, () => inFlight);
	}
	if (!gate.paid && debtMs >= MIN_PAYABLE_DEBT_MS) {
		gate.paid = true;
		gate.yielded = true;
		return timed(gate, startPayingDebt);
	}
	if (!gate.yielded) {
		gate.yielded = true;
		return new Promise<void>((resolve) => setImmediate(resolve));
	}
	return null;
}

function chunkRowsFor(dim: number): number {
	return Math.min(MAX_CHUNK_ROWS, Math.max(1, Math.floor(CHUNK_BYTES / (dim * 4))));
}

type ScanFailureReason = "index_missing" | "table_missing" | "scan_failed";

function noteFailure(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	let reason: ScanFailureReason = "scan_failed";
	if (/no such index/i.test(message)) {
		indexState = "missing";
		reason = "index_missing";
	} else if (/no such table/i.test(message)) {
		reason = "table_missing";
	}
	logOnce(`error:${reason}`, {
		kind: "ask_vector_scan_error",
		level: "error",
		reason,
		message: message.slice(0, LOGGED_ERROR_CHARS),
	});
}

function oldestEventCreatedAt(eventId: number | null): string | null {
	if (eventId === null) return null;
	const row = getSqlite()
		.prepare("SELECT created_at AS createdAt FROM events WHERE id = ?")
		.get(eventId) as {
		createdAt: string;
	} | null;
	const createdAtMs = row ? parseDbTimestamp(row.createdAt) : null;
	return createdAtMs === null ? null : new Date(createdAtMs).toISOString();
}

interface ChunkRow {
	eventId: number;
	vector: Uint8Array | null;
	sessionId: string | null;
}

/**
 * Scores the newest vectors of `model`/`dim` against `queryVec` and
 * aggregates per session (best score and the count of scores at or above the
 * floor). Rejects on any SQLite error; "no such index" also marks the index
 * state `missing`. Budgets and CPU share are read from `config` per call.
 */
export async function scanSessionSimilarity(
	queryVec: Float32Array,
	{ model, dim }: { model: string; dim: number },
): Promise<VectorScanResult> {
	const maxRows = config.vectorScanMaxRows;
	const maxMs = config.vectorScanMaxMs;
	const chunkRows = chunkRowsFor(dim);
	const startedAt = clock.now();
	const perSession = new Map<string, SessionSimilarity>();
	let returned = 0;
	let scored = 0;
	let skipped = 0;
	let statements = 0;
	let maxRowsPerStatement = 0;
	let busyMs = 0;
	let sleptMs = 0;
	let maxSliceMs = 0;
	let oldestEventId: number | null = null;
	let cursor = FIRST_EVENT_ID_BOUND;
	let stopReason: VectorScanStopReason;

	try {
		const statement = getSqlite().prepare(SCAN_SQL);
		const scratch = new Float32Array(dim);
		const scratchBytes = new Uint8Array(scratch.buffer);

		for (;;) {
			const gate: TurnGate = { yielded: statements === 0, paid: false, waitedMs: 0 };
			for (let wait = nextWait(gate); wait !== null; wait = nextWait(gate)) await wait;
			sleptMs += gate.waitedMs;

			const chunkStartedAt = clock.now();
			let rows: ChunkRow[];
			try {
				rows = statement.all(model, dim, cursor, chunkRows) as ChunkRow[];
				for (const row of rows) {
					if (row.vector === null || row.sessionId === null || row.vector.byteLength !== dim * 4) {
						skipped++;
						continue;
					}
					scratchBytes.set(row.vector);
					scored++;
					const similarity = cosineSimilarity(queryVec, scratch);
					if (similarity < SIMILARITY_FLOOR) continue;
					const entry = perSession.get(row.sessionId);
					if (entry === undefined) perSession.set(row.sessionId, { max: similarity, count: 1 });
					else {
						if (similarity > entry.max) entry.max = similarity;
						entry.count += 1;
					}
				}
			} finally {
				const chunkMs = clock.now() - chunkStartedAt;
				chargeDebt(chunkMs);
				busyMs += chunkMs;
				if (chunkMs > maxSliceMs) maxSliceMs = chunkMs;
			}

			statements++;
			returned += rows.length;
			if (rows.length > maxRowsPerStatement) maxRowsPerStatement = rows.length;
			for (const row of rows) {
				if (row.sessionId !== null) oldestEventId = row.eventId;
			}
			const last = rows[rows.length - 1];
			if (last !== undefined) cursor = last.eventId;

			if (rows.length < chunkRows) stopReason = "exhausted";
			else if (returned >= maxRows) stopReason = "row_budget";
			else if (clock.now() - startedAt >= maxMs) stopReason = "time_budget";
			else continue;
			break;
		}

		const stats: VectorScanStats = {
			model,
			dim,
			returned,
			scored,
			skipped,
			statements,
			maxRowsPerStatement,
			truncated: stopReason !== "exhausted",
			stopReason,
			ms: clock.now() - startedAt,
			busyMs,
			sleptMs,
			maxSliceMs,
			oldestEventId,
			oldestEventAt: oldestEventCreatedAt(oldestEventId),
		};
		lastStats = stats;
		indexState = "ok";
		if (stats.truncated) {
			logOnce("partial", {
				kind: "vector_scan_coverage_partial",
				level: "warn",
				stopReason: stats.stopReason,
				returned: stats.returned,
				oldestEventAt: stats.oldestEventAt,
			});
		}
		return { perSession, stats };
	} catch (err) {
		noteFailure(err);
		throw err;
	}
}

export function getLastVectorScanStats(): VectorScanStats | null {
	return lastStats;
}

/** `ok` after a successful scan, `missing` after one that found no index, `unknown` before either. */
export function getVectorScanIndexState(): VectorScanIndexState {
	return indexState;
}

/** Test-only: replace the clock the budgets and pacer read. */
export function __setVectorScanClockForTests(next: ScanClock): void {
	clock = next;
}

/** Test-only: forget stats, index state, log latches and pacer state, and restore the real clock. */
export function __resetVectorScanStateForTests(): void {
	pacerGeneration++;
	abortSleep?.();
	sleeping = null;
	abortSleep = null;
	debtMs = 0;
	lastStats = null;
	indexState = "unknown";
	loggedOnce.clear();
	clock = realClock;
}
