/**
 * Runs heavy synchronous-in-effect jobs one per turn of the event loop.
 *
 * SQLite statements run synchronously on the event loop, so a job that scans a
 * large table holds back everything queued behind it, however it is written as
 * promises. Run back to back, N such jobs hold the loop for N times as long and
 * a small, latency-sensitive request (an agent hook) waits for all of them. Here
 * jobs run strictly one at a time, in arrival order, and the next one starts on
 * a later turn of the loop (setImmediate), after the loop has polled for I/O —
 * so whatever else arrived is served between two jobs, not after the last.
 *
 * A job must not wait on another job queued here (that would never run).
 *
 * At most OWN_TURN_MAX_WAITING jobs wait. Past that a new job is refused at once
 * with OwnTurnBusyError instead of queueing, so one caller rotating the scope or
 * the search text cannot build an unbounded backlog of scans.
 */

/** The most jobs that may wait (not counting the one running) before new ones are refused. */
export const OWN_TURN_MAX_WAITING = 256;

/** Thrown by runInOwnTurn when the queue is full: the caller should answer "busy", not wait. */
export class OwnTurnBusyError extends Error {
	constructor() {
		super("The scan queue is full.");
		this.name = "OwnTurnBusyError";
	}
}

type Job = () => Promise<void>;

const queue: Job[] = [];
let running = false;
let pumpScheduled = false;

function pump(): void {
	if (running || pumpScheduled || queue.length === 0) return;
	pumpScheduled = true;
	setImmediate(() => {
		pumpScheduled = false;
		const job = queue.shift();
		if (!job) return;
		running = true;
		job().finally(() => {
			running = false;
			pump();
		});
	});
}

export function runInOwnTurn<T>(work: () => Promise<T>): Promise<T> {
	if (queue.length >= OWN_TURN_MAX_WAITING) return Promise.reject(new OwnTurnBusyError());
	return new Promise<T>((resolve, reject) => {
		queue.push(() => Promise.resolve().then(work).then(resolve, reject));
		pump();
	});
}
