/**
 * The start/stop contract every push background job follows (the Live Activity
 * publisher now, the daily digest next). A job does its work in `tick`; this
 * runs it on a timer that never overlaps itself, never keeps the process alive,
 * and stops cleanly. Time comes from an injected clock, so tests drive `tick`
 * directly and never wait on a timer.
 */
import { type Clock, type PushLogger, consolePushLogger, systemClock } from "./types.js";

export interface PushScheduler {
	/** The clock the job reads; injected so tests control time. */
	readonly clock: Clock;
	/** Begins work. Calling it again while running does nothing. */
	start(): void;
	/** Stops work. Anything in flight finishes; nothing new starts. */
	stop(): void;
}

export interface IntervalSchedulerOptions {
	name: string;
	intervalMs: number;
	tick: () => Promise<void>;
	/** Runs once at start, before the first interval. */
	onStart?: () => Promise<void>;
	onStop?: () => void;
	clock?: Clock;
	logger?: PushLogger;
}

/** A `PushScheduler` that calls `tick` every `intervalMs`, one call at a time. */
export class IntervalScheduler implements PushScheduler {
	readonly clock: Clock;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly logger: PushLogger;

	constructor(private readonly options: IntervalSchedulerOptions) {
		this.clock = options.clock ?? systemClock;
		this.logger = options.logger ?? consolePushLogger;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.runTick(), this.options.intervalMs);
		this.timer.unref?.();
		if (this.options.onStart) {
			this.options.onStart().catch((err: unknown) => this.logFailure("start", err));
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.options.onStop?.();
	}

	get started(): boolean {
		return this.timer !== null;
	}

	/** One pass, skipped if the last one is still going. Never rejects. */
	async runTick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.options.tick();
		} catch (err) {
			this.logFailure("tick", err);
		} finally {
			this.running = false;
		}
	}

	private logFailure(phase: string, err: unknown): void {
		this.logger.warn(`${this.options.name} ${phase} failed`, {
			error: err instanceof Error ? err.name : "unknown",
		});
	}
}
