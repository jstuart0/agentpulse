/**
 * Per-subject fixed-window counter, in memory (a restart clears it, and each
 * replica counts for itself). Shared by the limits that count events per
 * subject per window: session creation and key minting.
 *
 * Expired windows are swept once per window length, so the cost is amortised
 * over the calls in between and a call never scans the whole map.
 */
interface Window {
	startedAtMs: number;
	count: number;
	overLimitNoted: boolean;
}

export class FixedWindowCounter {
	private readonly windows = new Map<string, Window>();
	private clock: () => number = Date.now;
	private nextSweepAtMs = 0;

	constructor(private readonly windowMs: number) {}

	/** True when the subject may do one more thing now (and counts it). */
	tryConsume(subject: string, limit: number): boolean {
		const nowMs = this.clock();
		if (nowMs >= this.nextSweepAtMs) {
			this.sweepExpired(nowMs);
			this.nextSweepAtMs = nowMs + this.windowMs;
		}

		const window = this.windows.get(subject);
		if (!window || nowMs - window.startedAtMs >= this.windowMs) {
			this.windows.set(subject, { startedAtMs: nowMs, count: 1, overLimitNoted: false });
			return true;
		}
		if (window.count >= limit) return false;
		window.count++;
		return true;
	}

	/** True when the subject has already used `limit` in its current window (counts nothing). */
	isAtLimit(subject: string, limit: number): boolean {
		const window = this.windows.get(subject);
		if (!window || this.clock() - window.startedAtMs >= this.windowMs) return false;
		return window.count >= limit;
	}

	/** Milliseconds until the subject's current window ends; 0 when it has none. */
	msUntilWindowEnds(subject: string): number {
		const window = this.windows.get(subject);
		if (!window) return 0;
		return Math.max(0, window.startedAtMs + this.windowMs - this.clock());
	}

	/** Forgets the subject's window. */
	clear(subject: string): void {
		this.windows.delete(subject);
	}

	/** True the first time an over-limit subject is noted in its window: the caller logs then, once. */
	noteOverLimitOnce(subject: string): boolean {
		const window = this.windows.get(subject);
		if (!window || window.overLimitNoted) return false;
		window.overLimitNoted = true;
		return true;
	}

	get trackedSubjects(): number {
		return this.windows.size;
	}

	setClock(clock: (() => number) | null): void {
		this.clock = clock ?? Date.now;
	}

	reset(): void {
		this.windows.clear();
		this.nextSweepAtMs = 0;
	}

	private sweepExpired(nowMs: number): void {
		for (const [subject, window] of this.windows) {
			if (nowMs - window.startedAtMs >= this.windowMs) this.windows.delete(subject);
		}
	}
}
