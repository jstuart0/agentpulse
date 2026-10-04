/**
 * Counts event-loop turns with a self-rescheduling `setImmediate`. A
 * microtask-only yield never lets an immediate run, so code that yields that
 * way shows zero ticks between its statements; a `setTimeout(0)` yield shows
 * many.
 */
export interface Ticker {
	readonly ticks: number;
	stop(): void;
}

export function startTicker(): Ticker {
	let ticks = 0;
	let running = true;
	const loop = () => {
		if (!running) return;
		ticks++;
		setImmediate(loop);
	};
	setImmediate(loop);
	return {
		get ticks() {
			return ticks;
		},
		stop() {
			running = false;
		},
	};
}
