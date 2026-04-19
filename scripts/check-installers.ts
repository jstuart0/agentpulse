import { readFile } from "fs/promises";

async function mustInclude(path: string, expected: string) {
	const content = await readFile(path, "utf8");
	if (!content.includes(expected)) {
		throw new Error(`${path} is missing expected content: ${expected}`);
	}
}

async function main() {
	await mustInclude("scripts/install-local.sh", "AUTO_SUPERVISOR=\"true\"");
	await mustInclude("scripts/install-local.sh", "run supervisor");
	await mustInclude("scripts/install-local.ps1", "AgentPulseSupervisor");
	await mustInclude("scripts/install-local.ps1", "run supervisor");
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.sh"');
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.ps1"');
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.sh`)");
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.ps1`)");
	await mustInclude("Dockerfile", "COPY --from=builder /app/scripts ./scripts");
	console.log("installer checks passed");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
