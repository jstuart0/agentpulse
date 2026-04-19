import { loadSupervisorConfig, saveSupervisorConfig } from "./config.js";
import { launchClaudeRequest } from "./providers/claude.js";
import type { LaunchRequest } from "../shared/types.js";

async function request(path: string, options?: RequestInit) {
	const config = await loadSupervisorConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
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
	};

	if (config.id !== registration.supervisor.id) {
		await saveSupervisorConfig({
			...config,
			id: registration.supervisor.id,
		});
	}

	console.log(
		`[supervisor] Registered ${registration.supervisor.hostName} (${registration.supervisor.id})`,
	);

	async function dispatchLaunch(launch: LaunchRequest) {
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
			const result = await launchClaudeRequest(launch);
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
}

main().catch((error) => {
	console.error("[supervisor] fatal", error);
	process.exit(1);
});
