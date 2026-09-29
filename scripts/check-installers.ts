import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../src/server/installers.js";

const ROOT = join(import.meta.dir, "..");

export async function mustInclude(path: string, expected: string) {
	const content = await readFile(join(ROOT, path), "utf8");
	if (!content.includes(expected)) {
		throw new Error(`${path} is missing expected content: ${expected}`);
	}
}

/**
 * F163: /setup-relay.sh is built by the server's own buildRelayInstaller from
 * the embedded sources; if these scripts can't be spliced, CI fails here
 * rather than every request answering 503.
 */
function checkRelayInstallerBuilds() {
	const built = buildRelayInstaller(INSTALLER_SOURCES, "https://example.invalid");
	if (!built.ok) throw new Error(`/setup-relay.sh can't be built: ${built.reason}`);
	if (built.script.includes("@@AGENTPULSE_")) {
		throw new Error("/setup-relay.sh still carries an installer marker after splicing");
	}
}

/**
 * F165/F194: the server embeds relay.ts with a text import, and Bun caches
 * modules by path, so a plain module import of relay.ts in the same process
 * (a test) gets the text or poisons the embed. Module imports must say
 * "?module". Catches `import`/`require`, with or without a ".ts"/".js"
 * extension — Bun and TypeScript both resolve "./relay" to relay.ts, so an
 * extensionless import poisons the embed just as much as an unsuffixed
 * "relay.ts" one. The word boundary before "relay" and the extension-or-quote
 * right after it keep this from flagging unrelated names like "relayEvent".
 */
export async function checkNoPlainRelayModuleImport() {
	const offenders: string[] = [];
	const plain =
		/(?<!typeof )(?:import\s*\(\s*|require\s*\(\s*|from\s+)["'][^"']*\brelay(?:\.(?:ts|js))?["']/;
	for (const pattern of [
		"scripts/**/*.ts",
		"src/**/*.ts",
		"src/**/*.tsx",
		"bin/**/*.ts",
		// Scoped to each package's src/ (not packages/**) so this never walks
		// into a workspace member's own node_modules (e.g.
		// packages/agentpulse-mcp/node_modules).
		"packages/*/src/**/*.ts",
		"packages/*/src/**/*.tsx",
	]) {
		for await (const path of new Glob(pattern).scan(ROOT)) {
			if (path === "src/server/installers.ts") continue;
			const content = await readFile(join(ROOT, path), "utf8");
			content.split("\n").forEach((line, i) => {
				if (plain.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
			});
		}
	}
	if (offenders.length > 0) {
		throw new Error(`import relay.ts as "relay.ts?module", not plainly:\n${offenders.join("\n")}`);
	}
}

async function main() {
	await mustInclude("scripts/install-local.sh", 'AUTO_SUPERVISOR="true"');
	await mustInclude("scripts/install-local.sh", "run supervisor");
	// F196: setup.ts's `.replace('PUBLIC_URL=""', ...)` is a silent no-op if
	// this exact placeholder ever drifts (no error, the served script just
	// keeps an empty PUBLIC_URL) — pin it so a drifted placeholder fails here
	// instead of shipping a broken installer.
	await mustInclude("scripts/install-local.sh", 'PUBLIC_URL=""');
	await mustInclude("scripts/install-local.ps1", "AgentPulseSupervisor");
	await mustInclude("scripts/install-local.ps1", "run supervisor");
	await mustInclude("scripts/install-local.ps1", '[string]$PublicUrl = ""');
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.sh"');
	await mustInclude("src/server/routes/setup.ts", 'setup.get("/install-local.ps1"');
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.sh`)");
	await mustInclude("deploy/k8s/07-ingressroute.yaml", "Path(`/install-local.ps1`)");
	await mustInclude("Dockerfile", "COPY --chown=bun:bun --from=builder /app/scripts ./scripts");
	checkRelayInstallerBuilds();
	await checkNoPlainRelayModuleImport();
	const retired = await access(join(ROOT, "scripts/codex-hook.sh")).then(
		() => false,
		() => true,
	);
	if (!retired)
		throw new Error("scripts/codex-hook.sh was removed in favor of Codex command hooks");
	console.log("installer checks passed");
}

// Guarded so a test can import checkNoPlainRelayModuleImport without also
// running (and process.exit-ing on) the full check suite.
if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
