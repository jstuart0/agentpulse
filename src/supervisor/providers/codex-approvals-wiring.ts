/**
 * The supervisor's approvals wiring in one function (AGEN-87), so it can be run and tested on its own:
 * main() performs real network calls and can't be. It builds the tracker on the report gate, tells it
 * what the server said it can do at registration, installs it as the tracker managed Codex runtimes
 * attach to, and starts the beat that runs deadlines, report retries and the poll.
 */
import {
	type ApprovalGatePort,
	type CodexApprovalTracker,
	configureCodexApprovals,
	createCodexApprovalTracker,
} from "./codex-approvals.js";

/** How often the approvals tracker beats. It does nothing when nothing is held. */
export const APPROVALS_TICK_MS = 1_000;

export type ApprovalsWiringOptions = {
	gate: ApprovalGatePort;
	/** What registration said the server can do; absent means off. */
	serverFeatures: readonly string[] | null | undefined;
	/** Runs `callback` every `ms`. The default is an unref'd interval. */
	schedule?: (callback: () => void, ms: number) => unknown;
	onTickError?: (error: unknown) => void;
};

export type ApprovalsWiring = {
	approvals: CodexApprovalTracker;
	/**
	 * Sends a heartbeat through `send` and applies the features its answer carries, only when it
	 * succeeded: a failed heartbeat leaves the last known features alone.
	 */
	applyHeartbeat<T extends { serverFeatures?: readonly string[] } | null | undefined>(
		send: () => Promise<T>,
	): Promise<T>;
};

const defaultSchedule = (callback: () => void, ms: number) => {
	const timer = setInterval(callback, ms);
	timer.unref();
	return timer;
};

export function wireCodexApprovals(options: ApprovalsWiringOptions): ApprovalsWiring {
	const approvals = createCodexApprovalTracker({ gate: options.gate });
	approvals.setServerFeatures(options.serverFeatures);
	configureCodexApprovals(approvals);
	const schedule = options.schedule ?? defaultSchedule;
	const onTickError =
		options.onTickError ?? ((error) => console.error("[supervisor] approvals tick failed", error));
	schedule(() => {
		approvals.tick().catch(onTickError);
	}, APPROVALS_TICK_MS);
	return {
		approvals,
		async applyHeartbeat(send) {
			const beat = await send();
			approvals.setServerFeatures(beat?.serverFeatures);
			return beat;
		},
	};
}
