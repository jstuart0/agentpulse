import { isAiActive } from "./feature.js";
import {
	claimNextRun,
	reclaimExpiredLeases,
	type WatcherRunRecord,
} from "./watcher-runs-service.js";

/**
 * Run leaser (Phase 1 sub-phase 1d). Owns the polling/claim side of
 * the durable watcher queue. The runner provides a `processRun` callback
 * and the leaser handles:
 *
 *   - startup reclaim of expired leases
 *   - per-tick claim until the queue is empty
 *   - reentrancy guard so concurrent ticks don't pile up
 *
 * Execution of a claimed run still lives in the runner — the leaser
 * only drives claim/drain so the runner's responsibilities stay
 * focused on building context and calling the LLM.
 */

export interface RunLeaserOptions {
	leaseOwner: string;
	leaseDurationMs: number;
	intervalMs: number;
	processRun: (run: WatcherRunRecord) => Promise<void>;
	shouldRun?: () => Promise<boolean>;
}

export class RunLeaser {
	private interval: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	constructor(private readonly opts: RunLeaserOptions) {}

	async start(): Promise<void> {
		if (this.interval) return;

		try {
			const reclaimed = await reclaimExpiredLeases();
			if (reclaimed > 0) {
				console.log(`[run-leaser] reclaimed ${reclaimed} expired runs on startup`);
			}
		} catch (err) {
			console.warn("[run-leaser] startup reclaim failed:", err);
		}

		this.interval = setInterval(() => {
			void this.drain();
		}, this.opts.intervalMs);
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** Claim every queued run available right now. Guarded against re-entry. */
	async drain(): Promise<void> {
		if (this.busy) return;
		const shouldRun = this.opts.shouldRun ?? isAiActive;
		if (!(await shouldRun())) return;
		this.busy = true;
		try {
			while (true) {
				const run = await claimNextRun({
					leaseOwner: this.opts.leaseOwner,
					leaseDurationMs: this.opts.leaseDurationMs,
				});
				if (!run) return;
				await this.opts.processRun(run);
			}
		} catch (err) {
			console.error("[run-leaser] drain failed:", err);
		} finally {
			this.busy = false;
		}
	}
}
