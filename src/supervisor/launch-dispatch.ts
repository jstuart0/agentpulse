/**
 * Starts a claimed launch request: refuse it, or run its prelaunch actions and
 * hand it to the provider for its mode, reporting each step as it goes.
 *
 * Every report goes through the report gate. The very first thing a launch gets
 * is a check against the user's exclude rules: a launch in a covered directory,
 * or while the rules file has an error, is refused with one fixed status, before
 * any "launching" status, prelaunch action, provider call or process. That status
 * is the same bytes a prelaunch path refused for the trusted roots gets while
 * rules are in place, and it never says which; the reason goes to the host's own
 * log only. Nothing else is checked on the way in: the server judged the
 * directory against this host's trusted roots when the launch was requested, and
 * the prelaunch actions check their own paths.
 */
import type { LaunchRequest } from "../shared/types.js";
import type { LaunchCallbacks } from "./providers/claude-shared.js";
import type {
	launchClaudeHeadlessRequest,
	launchClaudeInteractiveRequest,
} from "./providers/claude.js";
import type { launchManagedCodexRequest } from "./providers/codex-managed.js";
import { PrelaunchError, type executePrelaunchActions } from "./services/prelaunch-actions.js";
import { LAUNCH_REFUSED_CODE, type ReportGate } from "./services/report-gate.js";

export type LaunchProviders = {
	launchManagedCodex: typeof launchManagedCodexRequest;
	launchClaudeHeadless: typeof launchClaudeHeadlessRequest;
	launchClaudeInteractive: typeof launchClaudeInteractiveRequest;
};

export interface LaunchDispatchDeps {
	gate: ReportGate;
	trustedRoots: string[];
	providers: LaunchProviders;
	executePrelaunchActions: typeof executePrelaunchActions;
	/** The host's own log: the only place the reason for a refusal is written. */
	log?: (line: string) => void;
	warn?: (line: string) => void;
}

export function createLaunchDispatcher(
	deps: LaunchDispatchDeps,
): (launch: LaunchRequest) => Promise<void> {
	const { gate, providers } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));
	const warn = deps.warn ?? ((line: string) => console.warn(line));

	/** Why this host will not start anything in the launch's directory, or null. Specifics are for the local log only. */
	function refusalReason(launch: LaunchRequest): string | null {
		if (!gate.noteLaunch(launch.id, launch.launchCorrelationId, launch.cwd)) {
			return "too_many_live_sessions: this host is following as many sessions as it can";
		}
		const verdict = gate.verdict(launch.id, launch.cwd);
		if (verdict === "excluded" || verdict === "refused") {
			return `cwd_excluded: ${launch.cwd} is covered by an exclude rule`;
		}
		if (verdict === "blocked") {
			return "rules_invalid: the exclude file or the gate's saved state has an error (see the earlier log lines), so no launch can be judged";
		}
		return null;
	}

	async function runPrelaunchActionsForLaunch(launch: LaunchRequest): Promise<boolean> {
		const actions = launch.launchSpec.prelaunchActions;
		if (!actions || actions.length === 0) return true;
		try {
			await deps.executePrelaunchActions(actions, {
				trustedRoots: deps.trustedRoots,
				logProgress: (msg) => log(`[prelaunch] ${msg}`),
				logWarning: (msg) => warn(msg),
			});
			return true;
		} catch (error) {
			const detail = error instanceof PrelaunchError ? error.toJSON() : null;
			if (detail?.code === LAUNCH_REFUSED_CODE && gate.rulesState() !== "none") {
				// While rules exist, the same fixed body a refusal at the top gets: which path it was stays
				// on this host. With no rules file nothing needs hiding and the specific status stands.
				log(`[supervisor] launch ${launch.id} refused: ${detail.code}: ${detail.message}`);
				await gate.refuseLaunch(launch.id);
				return false;
			}
			await gate.reportLaunchStatus(launch.id, {
				status: "failed",
				error: detail?.message ?? (error instanceof Error ? error.message : "Prelaunch failed"),
				providerLaunchMetadata: detail ? { prelaunchError: detail } : null,
			});
			return false;
		}
	}

	function callbacksFor(launch: LaunchRequest): LaunchCallbacks {
		return {
			reportState: (body) => gate.reportState(body),
			reportEvents: (events) => gate.reportEvents(launch.launchCorrelationId, events),
		};
	}

	return async function dispatchLaunch(launch) {
		const refusal = refusalReason(launch);
		if (refusal) {
			log(`[supervisor] launch ${launch.id} refused: ${refusal}`);
			await gate.refuseLaunch(launch.id);
			return;
		}

		if (launch.agentType === "codex_cli" && launch.requestedLaunchMode === "managed_codex") {
			await gate.reportLaunchStatus(launch.id, { status: "launching" });
			if (!(await runPrelaunchActionsForLaunch(launch))) return;
			try {
				const result = await providers.launchManagedCodex(launch, callbacksFor(launch));
				await gate.reportLaunchStatus(launch.id, {
					status: "running",
					pid: result.pid,
					providerLaunchMetadata: result.metadata,
				});
			} catch (error) {
				await gate.reportLaunchStatus(launch.id, {
					status: "failed",
					error: error instanceof Error ? error.message : "Managed Codex launch failed",
				});
			}
			return;
		}

		if (launch.agentType !== "claude_code") {
			await gate.reportLaunchStatus(launch.id, {
				status: "failed",
				error: "This host can only start Claude Code launches and managed Codex launches.",
			});
			return;
		}

		await gate.reportLaunchStatus(launch.id, { status: "launching" });
		if (!(await runPrelaunchActionsForLaunch(launch))) return;

		try {
			const callbacks = callbacksFor(launch);
			if (launch.requestedLaunchMode === "headless") {
				const result = await providers.launchClaudeHeadless(
					launch,
					async (update) => {
						await gate.reportLaunchStatus(launch.id, {
							status: update.status,
							pid: update.pid ?? null,
							error: update.error ?? null,
							providerLaunchMetadata: update.providerLaunchMetadata,
						});
					},
					callbacks,
				);
				await gate.reportLaunchStatus(launch.id, {
					status: "running",
					pid: result.pid,
					providerLaunchMetadata: result.metadata,
				});
				void result.monitor;
				return;
			}

			const result = await providers.launchClaudeInteractive(launch, callbacks);
			await gate.reportLaunchStatus(launch.id, {
				status: "awaiting_session",
				pid: result.pid,
				providerLaunchMetadata: result.metadata,
			});
		} catch (error) {
			await gate.reportLaunchStatus(launch.id, {
				status: "failed",
				error: error instanceof Error ? error.message : "Launch failed",
			});
		}
	};
}
