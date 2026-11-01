/**
 * Caps how many replay deliveries (reports a supervisor sends late, from its
 * offline queue, marked with the replay header) the server works on at once.
 * A fleet reconnecting together would otherwise turn every queue into
 * simultaneous writes. Live reports are never counted or refused.
 *
 * Per process, in memory, like the other limiters (N replicas admit N times as
 * many).
 */

export const MAX_CONCURRENT_REPLAYS = 4;
/** What a refused replay is told to wait, in seconds. */
export const REPLAY_RETRY_AFTER_SECONDS = 2;

let inFlight = 0;
let maxConcurrent = MAX_CONCURRENT_REPLAYS;

/** Takes a slot, or returns null when all are in use. Release the returned function exactly once. */
export function tryAcquireReplay(): (() => void) | null {
	if (inFlight >= maxConcurrent) return null;
	inFlight++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		inFlight = Math.max(0, inFlight - 1);
	};
}

export function replaysInFlight(): number {
	return inFlight;
}

/** Test seam: change the cap, or restore it with no argument; also forgets any slot still held. */
export function __resetReplayLimiterForTests(max: number = MAX_CONCURRENT_REPLAYS): void {
	maxConcurrent = max;
	inFlight = 0;
}
