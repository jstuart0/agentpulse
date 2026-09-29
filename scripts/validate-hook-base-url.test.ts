/**
 * F245 (High, codex r2 D38): ap_validate_hook_base_url is the shared
 * primitive (inside the `# >>> agentpulse-hook-cmd` marker block, verbatim
 * across scripts/setup-hooks.sh, scripts/setup-relay.sh, and the /setup.sh
 * template rendered by src/server/routes/setup.ts) that rejects a
 * malformed --url before any hook JSON generation — same grammar as
 * assertValidHookBaseUrl() in src/shared/hook-command.ts. Without it, a
 * --url containing a quote/space/$(...)/backtick could persist as shell
 * code embedded inside the generated hooks.json, executing on a later
 * hook fire.
 *
 * This sources the REAL function from each file (never reimplements it),
 * matching hook-command-parity.test.ts's existing pattern.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function extractMarkerBlock(source: string): string {
	const startMarker = "# >>> agentpulse-hook-cmd";
	const endMarker = "# <<< agentpulse-hook-cmd";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error("agentpulse-hook-cmd markers not found");
	}
	return source.slice(start, end + endMarker.length);
}

async function renderedSetupSh(): Promise<string> {
	const { Hono } = await import("hono");
	const { setup } = await import("../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

type Site = { name: string; block: () => Promise<string> };

const SITES: Site[] = [
	{
		name: "scripts/setup-hooks.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf-8")),
	},
	{
		name: "scripts/setup-relay.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf-8")),
	},
	{
		name: "rendered GET /setup.sh",
		block: async () => extractMarkerBlock(await renderedSetupSh()),
	},
];

async function runValidate(
	block: string,
	url: string,
): Promise<{ code: number | null; stderr: string }> {
	// url arrives via a positional param (not interpolated into the script
	// text) so it's never re-parsed by the child shell — that would defeat
	// the point of testing injection payloads.
	const script = `${block}\nap_validate_hook_base_url "$1"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", url], { stdout: "pipe", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

const REJECTED = [
	"http://host'; rm -rf /",
	"http://host with space",
	"http://host$(whoami)",
	"http://host`whoami`",
	"http://host/path",
	"http://host?q=1",
];

const ACCEPTED = [
	"http://localhost:3000",
	"https://agentpulse.example.com:8443",
	"http://[::1]:4000",
];

for (const site of SITES) {
	describe(`ap_validate_hook_base_url (F245) — ${site.name}`, () => {
		for (const url of REJECTED) {
			test(`rejects ${JSON.stringify(url)}`, async () => {
				const block = await site.block();
				const result = await runValidate(block, url);
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/invalid AgentPulse base URL/);
			});
		}
		for (const url of ACCEPTED) {
			test(`accepts ${url}`, async () => {
				const block = await site.block();
				const result = await runValidate(block, url);
				expect(result.code).toBe(0);
			});
		}
	});
}
