/**
 * What one tick of each claim loop does: ask the server for a launch (or a control action), and hand what came
 * back to the right handler, or, while an update's drain is fresh, refuse it with the fixed sentence. The two
 * loops are one function each so a test can drive them with a fake claim source and a fake gate; `index.ts`
 * only schedules them.
 */
import { HOST_UPDATING_MESSAGE } from "../../shared/managed-messages.js";
import type { ControlAction, LaunchRequest } from "../../shared/types.js";
import type { ReportGate } from "./report-gate.js";
import { type UpdateDrain, routeClaimed } from "./update-drain.js";

export interface ClaimLoopDeps {
	/**
	 * The two claim calls, made by `index.ts` (the only place that holds the raw request function: a drift guard in
	 * report-gate.test.ts keeps session data from leaving any other way).
	 */
	claimLaunchRequest: () => Promise<{ launchRequest: LaunchRequest | null }>;
	claimActionRequest: () => Promise<{ action: ControlAction | null }>;
	drain: UpdateDrain;
	gate: Pick<
		ReportGate,
		"rulesState" | "refuseLaunch" | "reportLaunchStatus" | "reportControlStatus"
	>;
	dispatchLaunch: (launch: LaunchRequest) => Promise<void>;
	handleControlAction: (action: ControlAction) => Promise<void>;
	log?: (line: string, error: unknown) => void;
}

export function createClaimLoops(deps: ClaimLoopDeps) {
	const log = deps.log ?? ((line, error) => console.error(line, error));

	/** A launch claimed during a drain fails with the fixed sentence; while exclude rules exist the generic refusal goes instead, so a refusal never says anything about the rules. */
	async function refuseLaunch(launchId: string) {
		if (deps.gate.rulesState() !== "none") {
			await deps.gate.refuseLaunch(launchId);
		} else {
			await deps.gate.reportLaunchStatus(launchId, {
				status: "failed",
				error: HOST_UPDATING_MESSAGE,
			});
		}
	}

	return {
		async claimLaunch(): Promise<void> {
			try {
				const result = await deps.claimLaunchRequest();
				const launch = result.launchRequest;
				if (!launch) return;
				await routeClaimed({
					drain: deps.drain,
					kind: "launch",
					handle: () => deps.dispatchLaunch(launch),
					refuse: () => refuseLaunch(launch.id),
				});
			} catch (error) {
				log("[supervisor] claim failed", error);
			}
		},
		async claimControlAction(): Promise<void> {
			try {
				const result = await deps.claimActionRequest();
				const action = result.action;
				if (!action) return;
				await routeClaimed({
					drain: deps.drain,
					kind: action.actionType,
					handle: () => deps.handleControlAction(action),
					refuse: async () => {
						await deps.gate.reportControlStatus(action.id, action.sessionId ?? null, {
							status: "failed",
							error: HOST_UPDATING_MESSAGE,
						});
					},
				});
			} catch (error) {
				log("[supervisor] control action failed", error);
			}
		},
	};
}
