/**
 * A manual clock for tests. It never fakes `setImmediate`: code under test
 * that yields with a real macrotask still yields for real.
 */
export interface FakeClock {
	now(): number;
	/** A sleep that completes when the test advances time past it (or immediately when `autoAdvance`). */
	sleep(ms: number): Promise<void>;
	setTimer(fn: () => void, ms: number): number;
	clearTimer(handle: number): void;
	advance(ms: number): void;
	pendingTimers(): number;
	/** Milliseconds until the earliest pending timer, or null when none is pending. */
	nextTimerIn(): number | null;
	/** Every `sleep` duration requested, in order. */
	sleeps: number[];
}

export function createFakeClock(options: { autoAdvance?: boolean } = {}): FakeClock {
	let current = 0;
	let nextHandle = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const sleeps: number[] = [];

	function advance(ms: number) {
		const target = current + ms;
		for (;;) {
			let due: [number, { at: number; fn: () => void }] | null = null;
			for (const entry of timers) {
				if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
			}
			if (!due) break;
			timers.delete(due[0]);
			current = Math.max(current, due[1].at);
			due[1].fn();
		}
		current = target;
	}

	function setTimer(fn: () => void, ms: number): number {
		const handle = nextHandle++;
		timers.set(handle, { at: current + ms, fn });
		return handle;
	}

	return {
		now: () => current,
		sleep(ms) {
			sleeps.push(ms);
			if (options.autoAdvance) {
				advance(ms);
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => setTimer(resolve, ms));
		},
		setTimer,
		clearTimer: (handle) => {
			timers.delete(handle);
		},
		advance,
		pendingTimers: () => timers.size,
		nextTimerIn() {
			let earliest: number | null = null;
			for (const { at } of timers.values()) {
				if (earliest === null || at < earliest) earliest = at;
			}
			return earliest === null ? null : Math.max(0, earliest - current);
		},
		sleeps,
	};
}

/**
 * Resolves `work` while stepping a non-auto-advancing clock: lets the event
 * loop settle, then jumps to the next pending timer, until `work` settles.
 */
export async function runWithClock<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
	let settled = false;
	work.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	while (!settled) {
		for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		const next = clock.nextTimerIn();
		if (!settled && next !== null) clock.advance(next);
	}
	return work;
}
