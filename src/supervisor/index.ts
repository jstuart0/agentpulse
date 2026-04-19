import { loadSupervisorConfig, saveSupervisorConfig } from "./config.js";

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
