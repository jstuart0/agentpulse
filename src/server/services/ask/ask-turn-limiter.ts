import { config } from "../../config.js";

/**
 * The global limit on concurrent Ask turns. A turn is the unit that costs
 * something (classifier calls, an embedding, a vector scan, an LLM answer),
 * so the limit is on turns, and everything that runs one takes a slot: the
 * web routes and Telegram alike.
 *
 * Up to `config.askMaxConcurrent` turns hold a slot. Further callers wait,
 * first in first out, up to MAX_WAITERS of them and each for at most
 * WAIT_MS; beyond that, or after that, they are refused with AskBusyError. A
 * waiter whose caller goes away (an aborted signal) leaves the queue at once.
 * A slot is held until its holder releases it, and only the holder can: there
 * is no deadline and no forced release, because the work it guards cannot be
 * cancelled from here.
 */

export const MAX_WAITERS = 4;
export const WAIT_MS = 30_000;

/** What a refused or abandoned caller is told. Fixed text: no internal detail. */
export const ASK_BUSY_MESSAGE = "Ask is busy right now. Try again in a few seconds.";

export class AskBusyError extends Error {
	constructor() {
		super(ASK_BUSY_MESSAGE);
		this.name = "AskBusyError";
	}
}

/** The caller's signal fired while it was still waiting for a slot. */
export class AskTurnAbortedError extends Error {
	constructor() {
		super("The request was cancelled before the turn could start.");
		this.name = "AskTurnAbortedError";
	}
}

export interface AskTurnSlot {
	/** Frees the place. Safe to call more than once; only the first call counts. */
	release(): void;
}

export interface AskTurnLimiterStats {
	running: number;
	waiting: number;
	/** Callers refused as busy: the queue was full, or they waited out the 30 s. */
	rejected: number;
	/** Waiters that left because their caller went away. */
	aborted: number;
}

interface Timers {
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

const realTimers: Timers = {
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Waiter {
	grant(slot: AskTurnSlot): void;
	refuse(error: Error): void;
	timer: unknown;
	detach(): void;
}

let timers: Timers = realTimers;
let running = 0;
let rejected = 0;
let aborted = 0;
let queue: Waiter[] = [];

function newSlot(): AskTurnSlot {
	running++;
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			running--;
			admitWaiters();
		},
	};
}

function admitWaiters(): void {
	while (queue.length > 0 && running < config.askMaxConcurrent) {
		const waiter = queue.shift() as Waiter;
		timers.clearTimer(waiter.timer);
		waiter.detach();
		waiter.grant(newSlot());
	}
}

function leaveQueue(waiter: Waiter): void {
	queue = queue.filter((w) => w !== waiter);
}

/**
 * Takes a slot, waiting for one if need be. Rejects with AskBusyError when
 * the queue is full or the wait runs out, and with AskTurnAbortedError when
 * `signal` aborts first. The signal matters only while waiting: once the slot
 * is granted the turn runs to completion whatever happens to the caller.
 */
export function acquireAskTurn(opts: { signal?: AbortSignal } = {}): Promise<AskTurnSlot> {
	const { signal } = opts;
	if (signal?.aborted) return Promise.reject(new AskTurnAbortedError());
	admitWaiters();
	if (running < config.askMaxConcurrent) return Promise.resolve(newSlot());
	if (queue.length >= MAX_WAITERS) {
		rejected++;
		return Promise.reject(new AskBusyError());
	}
	return new Promise<AskTurnSlot>((resolve, reject) => {
		const onAbort = () => {
			timers.clearTimer(waiter.timer);
			leaveQueue(waiter);
			aborted++;
			reject(new AskTurnAbortedError());
		};
		const waiter: Waiter = {
			grant: resolve,
			refuse: reject,
			timer: undefined,
			detach: () => signal?.removeEventListener("abort", onAbort),
		};
		waiter.timer = timers.setTimer(() => {
			waiter.detach();
			leaveQueue(waiter);
			rejected++;
			reject(new AskBusyError());
		}, WAIT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		queue.push(waiter);
	});
}

/** Takes a slot only if one is free right now; never waits and never queues. */
export function tryAcquireAskTurn(): AskTurnSlot | null {
	admitWaiters();
	return running < config.askMaxConcurrent ? newSlot() : null;
}

export function getAskTurnLimiterStats(): AskTurnLimiterStats {
	return { running, waiting: queue.length, rejected, aborted };
}

/** Test-only: replace the timers the 30 s wait uses. */
export function __setAskLimiterClockForTests(next: Timers): void {
	timers = next;
}

/** Test-only: forget every slot, waiter and counter, and use the real timers. Pending waiters are dropped unsettled. */
export function __resetAskTurnLimiterForTests(): void {
	for (const waiter of queue) {
		timers.clearTimer(waiter.timer);
		waiter.detach();
	}
	queue = [];
	running = 0;
	rejected = 0;
	aborted = 0;
	timers = realTimers;
}
