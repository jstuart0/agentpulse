import { access, readFile } from "node:fs/promises";

async function mustInclude(path: string, expected: string) {
	const content = await readFile(path, "utf8");
	if (!content.includes(expected)) {
		throw new Error(`${path} is missing expected content: ${expected}`);
	}
}

function countLines(content: string, line: string) {
	return content.split("\n").filter((l) => l === line).length;
}

/**
 * /setup-relay.sh splices relay.ts and statusline.sh into setup-relay.sh at
 * its markers (setup.ts). Each marker must appear once, and neither source may
 * contain a marker or its heredoc terminator, or the server answers 503.
 */
async function checkRelayInstallerMarkers() {
	const installer = await readFile("scripts/setup-relay.sh", "utf8");
	const embeds = [
		["# @@AGENTPULSE_RELAY_TS@@", "scripts/relay.ts", "AGENTPULSE_RELAY_TS_EOF"],
		["# @@AGENTPULSE_STATUSLINE_SH@@", "scripts/statusline.sh", "AGENTPULSE_STATUSLINE_SH_EOF"],
	] as const;
	for (const [marker, source, terminator] of embeds) {
		if (countLines(installer, marker) !== 1) {
			throw new Error(`scripts/setup-relay.sh must have exactly one "${marker}" line`);
		}
		const content = await readFile(source, "utf8");
		if (content.includes("@@AGENTPULSE_") || countLines(content, terminator) > 0) {
			throw new Error(`${source} contains an installer marker or the line ${terminator}`);
		}
	}
	if (installer.split('REMOTE_URL_DEFAULT=""').length !== 2) {
		throw new Error('scripts/setup-relay.sh must have exactly one REMOTE_URL_DEFAULT="" line');
	}
	await mustInclude("src/server/routes/setup.ts", '"# @@AGENTPULSE_RELAY_TS@@"');
	await mustInclude("src/server/routes/setup.ts", '"# @@AGENTPULSE_STATUSLINE_SH@@"');
	const retired = await access("scripts/codex-hook.sh").then(
		() => false,
		() => true,
	);
	if (!retired)
		throw new Error("scripts/codex-hook.sh was removed in favor of Codex command hooks");
}

async function main() {
	await mustInclude("scripts/install-local.sh", 'AUTO_SUPERVISOR="true"');
	await mustInclude("scripts/install-local.sh", "run supervisor");
	await mustInclude("scripts/install-local.ps1", "AgentPulseSupervisor");
	await mustInclude("scripts/install-local.ps1", "run supervisor");
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.sh"');
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.ps1"');
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.sh`)");
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.ps1`)");
	await mustInclude("Dockerfile", "COPY --chown=bun:bun --from=builder /app/scripts ./scripts");
	await checkRelayInstallerMarkers();
	console.log("installer checks passed");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
