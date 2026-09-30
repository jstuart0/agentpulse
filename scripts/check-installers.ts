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
const PLAIN_RELAY_IMPORT_RE =
	/(?<!typeof )(?:import\s*\(\s*|require\s*\(\s*|from\s+)["'][^"']*\brelay(?:\.(?:ts|js))?["']/;

/**
 * F206: `Glob.scan()` lists a snapshot of paths, then each is read
 * separately — a path it enumerated can be deleted by the time its
 * `readFile` runs (e.g. this file's own test suite planting and cleaning
 * up throwaway fixtures under the very same scanned globs — see
 * scripts/check-installers.test.ts's plant()/afterEach — racing a second,
 * concurrent scan under host contention; confirmed by direct repro). A
 * path that no longer exists by read time is trivially not an offender:
 * ENOENT here is skipped, not a scan failure. Any other read error (a
 * real permissions problem, a real corrupt file) still fails loudly.
 */
export async function scanPathForPlainRelayImport(
	path: string,
	offenders: string[],
): Promise<void> {
	let content: string;
	try {
		content = await readFile(join(ROOT, path), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	content.split("\n").forEach((line, i) => {
		if (PLAIN_RELAY_IMPORT_RE.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
	});
}

export async function checkNoPlainRelayModuleImport() {
	const offenders: string[] = [];
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
			await scanPathForPlainRelayImport(path, offenders);
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
