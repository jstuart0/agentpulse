// SQLite-only, like the rest of event embeddings.

import { config } from "../../../config.js";
import { isVectorSearchBuildEnabled } from "../feature.js";
import {
	readNewestEventId,
	resolveEmbeddingAdapter,
	runBackfillPass,
} from "./embedding-service.js";

/**
 * The embedder's second path. Embedding an event inline needs the event on the
 * session bus, and a hook-delivered event is announced only on the WebSocket
 * channel, never on the bus (AGEN-79). So a running server embedded nothing
 * new after its boot-time backfill finished, until the next restart. This
 * schedule is what keeps the index current, and what makes it recover: a
 * provider that was down, a model that changed, a backlog left by either.
 *
 * Each tick is a bounded pass of the backfill. A pass handles at most
 * `BACKFILL_BATCHES_PER_PASS` batches, sleeping `BACKFILL_BATCH_PAUSE_MS` after
 * each on top of yielding to the event loop, so a large backlog is worked off
 * a slice at a time and ingest keeps its turn. The id cursor a pass ends on is
 * remembered (per model), so a later pass starts there instead of walking the
 * whole table again; an idle tick is one `MAX(id)` read.
 */

/** Between ticks when there is nothing left to do. */
export const BACKFILL_TICK_MS = 60_000;
/** Between ticks while a backlog remains (a pass ended on its batch budget). */
export const BACKFILL_CATCHUP_TICK_MS = 5_000;
/** The longest wait after repeated failures; the wait doubles from `BACKFILL_TICK_MS` up to this. */
export const BACKFILL_MAX_BACKOFF_MS = 15 * 60_000;
/** Batches (32 events each at most) one pass may embed. */
export const BACKFILL_BATCHES_PER_PASS = 100;
/** Sleep after each batch of a scheduled pass. */
export const BACKFILL_BATCH_PAUSE_MS = 200;
/** First tick after boot, so startup is not competing with it. */
export const BACKFILL_FIRST_TICK_MS = 15_000;
/**
 * A walk from id 0 is repeated this often. The remembered cursor assumes
 * nothing below it can become pending again; an event whose inline embed failed,
 * or a vector removed by hand, would otherwise stay missing until a restart.
 * The walk is cheap when little is pending (one bounded read per 5,000 ids).
 */
export const BACKFILL_FULL_WALK_MS = 6 * 3_600_000;

interface Covered {
	model: string;
	/** Every pending event at or below this id is embedded, or has no text. */
	id: number;
	/** When the walk that this cursor continues started from id 0. */
	walkStartedAtMs: number;
}

let covered: Covered | null = null;
let consecutiveFailures = 0;
let warnedNoProvider = false;

export interface TickOptions {
	maxBatches?: number;
	pauseMs?: number;
	/** Clock, for tests. */
	nowMs?: number;
}

export interface TickOutcome {
	/** Milliseconds until the next tick should run. */
	nextDelayMs: number;
	/** Events this tick embedded or marked as having no text. */
	handled: number;
}

function backoffMs(failures: number): number {
	return Math.min(BACKFILL_TICK_MS * 2 ** failures, BACKFILL_MAX_BACKOFF_MS);
}

/** One scheduled pass. Never throws: a failed tick is a longer wait, not a crashed timer. */
export async function runScheduledBackfillTick(options: TickOptions = {}): Promise<TickOutcome> {
	try {
		if (config.dialect !== "sqlite" || !isVectorSearchBuildEnabled()) {
			return { nextDelayMs: BACKFILL_TICK_MS, handled: 0 };
		}
		const adapter = await resolveEmbeddingAdapter();
		if (!adapter) {
			if (!warnedNoProvider) {
				warnedNoProvider = true;
				console.warn(
					"[embeddings] vector search built in but no embedding provider: Settings -> AI -> Vector search will surface a clearer error. The backfill checks again every minute.",
				);
			}
			return { nextDelayMs: BACKFILL_TICK_MS, handled: 0 };
		}
		warnedNoProvider = false;

		const nowMs = options.nowMs ?? Date.now();
		const continuing =
			covered !== null &&
			covered.model === adapter.model &&
			nowMs - covered.walkStartedAtMs < BACKFILL_FULL_WALK_MS;
		const from = continuing && covered ? covered.id : 0;
		const walkStartedAtMs = continuing && covered ? covered.walkStartedAtMs : nowMs;
		if (from > 0 && from >= readNewestEventId()) {
			return { nextDelayMs: BACKFILL_TICK_MS, handled: 0 };
		}

		const pass = await runBackfillPass({
			fromId: from,
			maxBatches: options.maxBatches ?? BACKFILL_BATCHES_PER_PASS,
			pauseMs: options.pauseMs ?? BACKFILL_BATCH_PAUSE_MS,
		});
		if (!pass.ran) return { nextDelayMs: BACKFILL_TICK_MS, handled: 0 };

		covered = { model: adapter.model, id: Math.max(pass.endCursor, from), walkStartedAtMs };
		if (pass.failed) {
			consecutiveFailures++;
			const nextDelayMs = backoffMs(consecutiveFailures);
			console.warn(
				JSON.stringify({
					kind: "embedding_backfill_paused",
					level: "warn",
					model: adapter.model,
					consecutiveFailedPasses: consecutiveFailures,
					retryInMs: nextDelayMs,
					error: pass.progress.error,
				}),
			);
			return { nextDelayMs, handled: pass.handled };
		}
		consecutiveFailures = 0;
		if (pass.handled > 0) {
			console.log(
				JSON.stringify({
					kind: "embedding_backfill_tick",
					level: "info",
					model: adapter.model,
					handled: pass.handled,
					cursor: pass.endCursor,
					backlogRemains: !pass.reachedEnd,
				}),
			);
		}
		return {
			nextDelayMs: pass.reachedEnd ? BACKFILL_TICK_MS : BACKFILL_CATCHUP_TICK_MS,
			handled: pass.handled,
		};
	} catch (err) {
		consecutiveFailures++;
		console.warn("[embeddings] scheduled backfill tick failed:", err);
		return { nextDelayMs: backoffMs(consecutiveFailures), handled: 0 };
	}
}

export interface ScheduleDeps {
	setTimer: (run: () => void, delayMs: number) => unknown;
	clearTimer: (handle: unknown) => void;
	tick: () => Promise<TickOutcome>;
}

const REAL_DEPS: ScheduleDeps = {
	setTimer: (run, delayMs) => {
		const handle = setTimeout(run, delayMs);
		handle.unref?.();
		return handle;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	tick: () => runScheduledBackfillTick(),
};

/**
 * Starts the schedule: a first tick shortly after boot, then one tick after
 * another, each waiting as long as the last one asked. Safe to call when vector
 * search is off (every tick is then a no-op). Returns a function that stops it.
 */
export function startEmbeddingBackfillSchedule(deps: ScheduleDeps = REAL_DEPS): () => void {
	let stopped = false;
	let handle: unknown;
	const arm = (delayMs: number) => {
		handle = deps.setTimer(() => {
			void deps.tick().then(({ nextDelayMs }) => {
				if (!stopped) arm(nextDelayMs);
			});
		}, delayMs);
	};
	arm(BACKFILL_FIRST_TICK_MS);
	return () => {
		stopped = true;
		deps.clearTimer(handle);
	};
}

/** Test-only: forget the remembered cursor and failure count. */
export function __resetEmbeddingScheduleForTests(): void {
	covered = null;
	consecutiveFailures = 0;
	warnedNoProvider = false;
}
