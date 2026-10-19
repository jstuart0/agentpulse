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
import { launchEnvErrors } from "../shared/launch-env-policy.js";
import { resolveLaunchPrivileges } from "../shared/launch-privileges.js";
import type { LaunchRequest } from "../shared/types.js";
import type { LaunchCallbacks } from "./providers/claude-shared.js";
import type {
	launchClaudeHeadlessRequest,
	launchClaudeInteractiveRequest,
} from "./providers/claude.js";
import type { launchManagedCodexRequest } from "./providers/codex-managed.js";
import { PrelaunchError, type executePrelaunchActions } from "./services/prelaunch-actions.js";
import { LAUNCH_REFUSED_CODE, type ReportGate } from "./services/report-gate.js";
import { assertCwdTrusted, canonicalSpawnCwd } from "./services/spawn-cwd.js";

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

	/**
	 * Fail a launch whose approval policy or sandbox mode can't be applied to its agent
	 * before anything else happens: no "launching" status, no prelaunch action, no process.
	 * Never falls back to the agent's defaults. Returns true when the launch was failed.
	 */
	async function failUnenforceableLaunch(launch: LaunchRequest): Promise<boolean> {
		const privileges = resolveLaunchPrivileges(
			launch.agentType,
			launch.approvalPolicy,
			launch.sandboxMode,
		);
		const errors = [...(privileges.ok ? [] : privileges.errors), ...launchEnvErrors(launch.env)];
		// A prompt that starts with '-' is refused here, before any prelaunch action runs, as it
		// is later when the argv is built. Only Claude takes its prompt on the command line.
		if (launch.agentType === "claude_code" && (launch.taskPrompt ?? "").trim().startsWith("-")) {
			errors.push(
				"The task prompt starts with '-', which could be read as a command-line option. Start it with a word instead.",
			);
		}
		// This supervisor's own mapping must agree with the one the server confirmed to the user.
		if (privileges.ok && launch.expectedEnforcedArgs !== undefined) {
			const expected = launch.expectedEnforcedArgs;
			if (
				expected.length !== privileges.cliArgs.length ||
				expected.some((arg, i) => arg !== privileges.cliArgs[i])
			) {
				errors.push(
					`This supervisor would apply [${privileges.cliArgs.join(" ")}] but the server confirmed [${expected.join(" ")}]. The two are different versions; update them together.`,
				);
			}
		}
		if (errors.length === 0) return false;
		log(`[supervisor] launch ${launch.id} not started: ${errors.join(" ")}`);
		await gate.reportLaunchStatus(launch.id, {
			status: "failed",
			error: `Launch not started: ${errors.join(" ")}`,
		});
		return true;
	}

	/** A directory problem fails the launch (or, while rules exist, is the generic refusal). True when it did. */
	async function failOnCwdProblem(launch: LaunchRequest, check: () => Promise<unknown>) {
		try {
			await check();
			return false;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Working directory refused";
			log(`[supervisor] launch ${launch.id} not started: ${message}`);
			if (gate.rulesState() !== "none") {
				await gate.refuseLaunch(launch.id);
			} else {
				await gate.reportLaunchStatus(launch.id, {
					status: "failed",
					error: `Launch not started: ${message}`,
				});
			}
			return true;
		}
	}

	/**
	 * The real directory to start the agent in, or null when the launch was failed or refused. The
	 * exclude rules are judged again against that real path: a symlink retargeted while prelaunch
	 * actions ran must not be able to carry a launch into a directory the rules cover.
	 */
	async function resolveSpawnCwd(launch: LaunchRequest): Promise<string | null> {
		let resolved: string | null = null;
		const failed = await failOnCwdProblem(launch, async () => {
			const canonical = await canonicalSpawnCwd(launch.cwd, deps.trustedRoots);
			if (gate.verdictForDirectory(canonical) !== "send") {
				throw new Error(`cwd_excluded: ${canonical} is covered by an exclude rule`);
			}
			resolved = canonical;
		});
		return failed ? null : resolved;
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
			if (await failUnenforceableLaunch(launch)) return;
			if (await failOnCwdProblem(launch, () => assertCwdTrusted(launch.cwd, deps.trustedRoots)))
				return;
			await gate.reportLaunchStatus(launch.id, { status: "launching" });
			if (!(await runPrelaunchActionsForLaunch(launch))) return;
			const spawnCwd = await resolveSpawnCwd(launch);
			if (spawnCwd === null) return;
			try {
				const result = await providers.launchManagedCodex(
					{ ...launch, cwd: spawnCwd },
					callbacksFor(launch),
				);
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

		if (await failUnenforceableLaunch(launch)) return;
		if (await failOnCwdProblem(launch, () => assertCwdTrusted(launch.cwd, deps.trustedRoots)))
			return;
		await gate.reportLaunchStatus(launch.id, { status: "launching" });
		if (!(await runPrelaunchActionsForLaunch(launch))) return;
		const spawnCwd = await resolveSpawnCwd(launch);
		if (spawnCwd === null) return;
		const spawnLaunch = { ...launch, cwd: spawnCwd };

		try {
			const callbacks = callbacksFor(launch);
			if (launch.requestedLaunchMode === "headless") {
				const result = await providers.launchClaudeHeadless(
					spawnLaunch,
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

			const result = await providers.launchClaudeInteractive(spawnLaunch, callbacks);
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
