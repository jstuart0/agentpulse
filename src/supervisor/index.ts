import { loadSupervisorConfig, saveSupervisorConfig } from "./config.js";
import {
	launchClaudeHeadlessRequest,
	launchClaudeInteractiveRequest,
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
} from "./providers/claude.js";
import type {
	ControlAction,
	LaunchRequest,
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../shared/types.js";
import {
	launchManagedCodexRequest,
	reconcileManagedCodexTitles,
	stopManagedCodexSession,
} from "./providers/codex-managed.js";

async function request(path: string, options?: RequestInit) {
	const config = await loadSupervisorConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.supervisorCredential) headers["X-AgentPulse-Supervisor-Token"] = config.supervisorCredential;
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

	const res = await fetch(`${config.serverUrl}/api/v1${path}`, {
		...options,
		headers,
	});
	if (!res.ok) {
		throw new Error(`Supervisor request failed: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

async function main() {
	const config = await loadSupervisorConfig();
	const registration = (await request("/supervisors/register", {
		method: "POST",
		body: JSON.stringify({
			id: config.id,
			enrollmentToken: config.enrollmentToken,
			hostName: config.hostName,
			platform: config.platform,
			arch: config.arch,
			version: config.version,
			trustedRoots: config.trustedRoots,
			capabilities: config.capabilities,
			capabilitySchemaVersion: 1,
			configSchemaVersion: 1,
		}),
	})) as {
		supervisor: { id: string; hostName: string };
		heartbeatIntervalMs: number;
		supervisorCredential?: string;
	};

	if (config.id !== registration.supervisor.id || registration.supervisorCredential) {
		await saveSupervisorConfig({
			...config,
			id: registration.supervisor.id,
			enrollmentToken: undefined,
			supervisorCredential: registration.supervisorCredential ?? config.supervisorCredential,
		});
	}

	console.log(
		`[supervisor] Registered ${registration.supervisor.hostName} (${registration.supervisor.id})`,
	);

	async function dispatchLaunch(launch: LaunchRequest) {
		if (launch.agentType === "codex_cli" && launch.requestedLaunchMode === "managed_codex") {
			await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
				method: "POST",
				body: JSON.stringify({
					status: "launching",
				}),
			});

			try {
				const result = await launchManagedCodexRequest(launch, {
					reportState: async (body) =>
						(await request(`/supervisors/${registration.supervisor.id}/managed-session-state`, {
							method: "POST",
							body: JSON.stringify(body),
						})) as { session: Session; managedSession: ManagedSession },
					reportEvents: async (events) => {
						await request(
							`/supervisors/${registration.supervisor.id}/managed-sessions/${launch.launchCorrelationId}/events`,
							{
								method: "POST",
								body: JSON.stringify({ events }),
							},
						);
					},
				});
				await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
					method: "POST",
					body: JSON.stringify({
						status: "running",
						pid: result.pid,
						providerLaunchMetadata: result.metadata,
					}),
				});
				return;
			} catch (error) {
				await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
					method: "POST",
					body: JSON.stringify({
						status: "failed",
						error: error instanceof Error ? error.message : "Managed Codex launch failed",
					}),
				});
				return;
			}
		}

		if (launch.agentType !== "claude_code") {
			await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
				method: "POST",
				body: JSON.stringify({
					status: "failed",
					error: "Phase 3 dispatch currently supports Claude Code only.",
				}),
			});
			return;
		}

		await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
			method: "POST",
			body: JSON.stringify({
				status: "launching",
			}),
		});

		try {
			const claudeCallbacks = {
				reportState: async (body: ManagedSessionStateInput) =>
					(await request(`/supervisors/${registration.supervisor.id}/managed-session-state`, {
						method: "POST",
						body: JSON.stringify(body),
					})) as { session: Session; managedSession: ManagedSession },
				reportEvents: async (events: ManagedSessionEventInput[]) => {
					await request(
						`/supervisors/${registration.supervisor.id}/managed-sessions/${launch.launchCorrelationId}/events`,
						{
							method: "POST",
							body: JSON.stringify({ events }),
						},
					);
				},
			};
			if (launch.requestedLaunchMode === "headless") {
				const result = await launchClaudeHeadlessRequest(
					launch,
					async (update) => {
						await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
							method: "POST",
							body: JSON.stringify({
								status: update.status,
								pid: update.pid ?? null,
								error: update.error ?? null,
								providerLaunchMetadata: update.providerLaunchMetadata,
							}),
						});
					},
					claudeCallbacks,
				);
				await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
					method: "POST",
					body: JSON.stringify({
						status: "running",
						pid: result.pid,
						providerLaunchMetadata: result.metadata,
					}),
				});
				void result.monitor;
				return;
			}

			const result = await launchClaudeInteractiveRequest(launch, claudeCallbacks);
			await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
				method: "POST",
				body: JSON.stringify({
					status: "awaiting_session",
					pid: result.pid,
					providerLaunchMetadata: result.metadata,
				}),
			});
		} catch (error) {
			await request(`/supervisors/${registration.supervisor.id}/launches/${launch.id}/status`, {
				method: "POST",
				body: JSON.stringify({
					status: "failed",
					error: error instanceof Error ? error.message : "Launch failed",
				}),
			});
		}
	}

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/launches/claim`,
				{ method: "POST" },
			)) as { launchRequest: LaunchRequest | null };
			if (result.launchRequest) {
				await dispatchLaunch(result.launchRequest);
			}
		} catch (error) {
			console.error("[supervisor] claim failed", error);
		}
	}, 3_000);

	setInterval(async () => {
		try {
			await request(`/supervisors/${registration.supervisor.id}/heartbeat`, {
				method: "POST",
			});
			console.log("[supervisor] heartbeat ok");
		} catch (error) {
			console.error("[supervisor] heartbeat failed", error);
		}
	}, registration.heartbeatIntervalMs);

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/provider-sync`,
			)) as { managedSessions: ManagedSession[] };
			await reconcileManagedCodexTitles(result.managedSessions ?? [], async (body) => {
				return (await request(`/supervisors/${registration.supervisor.id}/managed-session-state`, {
					method: "POST",
					body: JSON.stringify(body),
				})) as { session: Session; managedSession: ManagedSession };
			});
		} catch (error) {
			console.error("[supervisor] provider sync failed", error);
		}
	}, 3_000);

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/control-actions/claim`,
				{ method: "POST" },
			)) as { action: ControlAction | null };
			if (!result.action) return;

			if (result.action.actionType === "stop" && result.action.sessionId) {
				try {
					await stopManagedCodexSession(result.action.sessionId);
					await request(`/supervisors/${registration.supervisor.id}/managed-session-state`, {
						method: "POST",
						body: JSON.stringify({
							sessionId: result.action.sessionId,
							status: "completed",
							managedState: "stopped",
							providerSyncState: "synced",
						}),
					});
					await request(
						`/supervisors/${registration.supervisor.id}/managed-sessions/${result.action.sessionId}/events`,
						{
							method: "POST",
							body: JSON.stringify({
								events: [
									{
										eventType: "ManagedSessionStopped",
										category: "system_event",
										content: "Managed session stopped by operator.",
									},
								],
							}),
						},
					);
					await request(
						`/supervisors/${registration.supervisor.id}/control-actions/${result.action.id}/status`,
						{
							method: "POST",
							body: JSON.stringify({ status: "succeeded" }),
						},
					);
				} catch (error) {
					await request(
						`/supervisors/${registration.supervisor.id}/control-actions/${result.action.id}/status`,
						{
							method: "POST",
							body: JSON.stringify({
								status: "failed",
								error:
									error instanceof Error ? error.message : "Failed to stop managed session",
							}),
						},
					);
				}
				return;
			}

			if (result.action.actionType === "prompt" && result.action.sessionId) {
				const metadata = (result.action.metadata ?? {}) as Record<string, unknown>;
				const prompt = typeof metadata.prompt === "string" ? metadata.prompt : "";
				const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
				const model = typeof metadata.model === "string" ? metadata.model : null;
				const managedState =
					typeof metadata.managedState === "string" ? metadata.managedState : null;
				const env =
					metadata.env && typeof metadata.env === "object" && !Array.isArray(metadata.env)
						? (metadata.env as Record<string, string>)
						: {};
				const terminalOwner =
					metadata.terminalOwner &&
					typeof metadata.terminalOwner === "object" &&
					!Array.isArray(metadata.terminalOwner)
						? (metadata.terminalOwner as Record<string, unknown>)
						: null;
				const interactiveBridge =
					metadata.interactiveBridge &&
					typeof metadata.interactiveBridge === "object" &&
					!Array.isArray(metadata.interactiveBridge)
						? (metadata.interactiveBridge as Record<string, unknown>)
						: null;
				const claudeCallbacks = {
					reportState: async (body: ManagedSessionStateInput) =>
						(await request(`/supervisors/${registration.supervisor.id}/managed-session-state`, {
							method: "POST",
							body: JSON.stringify(body),
						})) as { session: Session; managedSession: ManagedSession },
					reportEvents: async (events: ManagedSessionEventInput[]) => {
						await request(
							`/supervisors/${registration.supervisor.id}/managed-sessions/${result.action!.sessionId}/events`,
							{
								method: "POST",
								body: JSON.stringify({ events }),
							},
						);
					},
				};

				try {
					if (!prompt || !cwd) {
						throw new Error("Prompt action is missing prompt or working directory.");
					}

					if (managedState === "interactive_terminal") {
						const response = await promptClaudeInteractiveSession(
							{
								sessionId: result.action.sessionId,
								prompt,
								cwd,
								model,
								env,
								managedState,
								terminalOwner,
								interactiveBridge,
							},
							claudeCallbacks,
						);
						await request(
							`/supervisors/${registration.supervisor.id}/control-actions/${result.action.id}/status`,
							{
								method: "POST",
								body: JSON.stringify({
									status: "succeeded",
									metadata: response.metadata,
								}),
							},
						);
						return;
					}

					const response = await promptClaudeHeadlessSession(
						{
							sessionId: result.action.sessionId,
							prompt,
							cwd,
							model,
							env,
							managedState,
						},
						async () => {},
						claudeCallbacks,
					);
					void response.monitor.then(async () => {
						await request(
							`/supervisors/${registration.supervisor.id}/control-actions/${result.action!.id}/status`,
							{
								method: "POST",
								body: JSON.stringify({
									status: "succeeded",
									metadata: response.metadata,
								}),
							},
						);
					}).catch(async (error) => {
						await request(
							`/supervisors/${registration.supervisor.id}/control-actions/${result.action!.id}/status`,
							{
								method: "POST",
								body: JSON.stringify({
									status: "failed",
									error: error instanceof Error ? error.message : "Failed to execute prompt",
								}),
							},
						);
					});
						return;
				} catch (error) {
					await request(
						`/supervisors/${registration.supervisor.id}/control-actions/${result.action.id}/status`,
						{
							method: "POST",
							body: JSON.stringify({
								status: "failed",
								error: error instanceof Error ? error.message : "Failed to execute prompt action",
							}),
						},
					);
				}
				return;
			}

			await request(
				`/supervisors/${registration.supervisor.id}/control-actions/${result.action.id}/status`,
				{
					method: "POST",
					body: JSON.stringify({
						status: "failed",
						error: `Unsupported control action: ${result.action.actionType}`,
					}),
				},
			);
		} catch (error) {
			console.error("[supervisor] control action failed", error);
		}
	}, 2_000);
}

main().catch((error) => {
	console.error("[supervisor] fatal", error);
	process.exit(1);
});
