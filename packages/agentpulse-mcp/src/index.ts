/**
 * stdio entry point (AGEN-12 Phase 2, D3 seam 2 / plan step 6) and this
 * package's public surface (D2 of the 2026-07-23 package extraction plan).
 *
 * Wired from this package's own `cli.ts` (`agentpulse-mcp serve`) and, for
 * the in-repo dev/self-host flow, from the main repo's `bin/cli.ts` shim.
 * All diagnostics go to stderr — the stdio transport owns stdout for the
 * JSON-RPC protocol stream.
 *
 * The re-exports below (client/errors/scopes/install symbols) are this
 * package's public API for external consumers importing `agentpulse-mcp`
 * as a library, not just running its bin. The in-repo shim
 * (`bin/cli.ts`'s `mcpInstall()`) deliberately does NOT import through this
 * barrel — it deep-imports the four individual source files instead, so
 * `agentpulse mcp install` never eagerly loads the MCP SDK or any tool file
 * (dexter G1; see bin/cli.ts's own comment).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttpClient } from "./client.js";
import { stderrLog } from "./log.js";
import { discoverScopes } from "./scopes.js";
import { buildMcpServer } from "./server.js";

export { createHttpClient } from "./client.js";
export { mapError } from "./errors.js";
export { ScopeDiscoveryError } from "./scopes.js";
export {
	InstallArgsError,
	parseInstallArgs,
	resolveAuthKey,
	runInstall,
} from "./install.js";

const DEFAULT_URL = "http://localhost:3000";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Cheap tripwire (xander Low, mid-build hardening) against a malicious
 * repo-shipped `.mcp.json`/config.toml pointing AGENTPULSE_URL at a remote
 * host: the Bearer API key is sent to whatever this resolves to on every
 * request. Warns, does not block — "point only at a server you control" is
 * documented guidance (Phase 6), not a technical enforcement; a legitimate
 * remote AgentPulse deployment is a supported, intended use case.
 */
function warnIfNonLocalHost(canonicalUrl: string): void {
	const host = new URL(canonicalUrl).hostname;
	if (!LOCAL_HOSTS.has(host)) {
		stderrLog(
			`warning: AGENTPULSE_URL points at a remote host "${host}" — the API key will be sent there; ensure you trust it.`,
		);
	}
}

export async function serveStdio(): Promise<void> {
	const baseUrl = process.env.AGENTPULSE_URL || DEFAULT_URL;
	const apiKey = process.env.AGENTPULSE_API_KEY;

	if (!apiKey) {
		stderrLog(
			"AGENTPULSE_API_KEY is required. Mint a key in Settings > API Keys, or run `agentpulse mcp install`.",
		);
		process.exit(1);
	}

	const client = createHttpClient({ baseUrl, apiKey });
	warnIfNonLocalHost(client.baseUrl);

	let scopes: string[];
	try {
		scopes = await discoverScopes(client);
	} catch (err) {
		stderrLog(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	const { server } = buildMcpServer({ client, scopes });
	const transport = new StdioServerTransport();
	await server.connect(transport);

	stderrLog(`AgentPulse MCP server connected to ${client.baseUrl} (scopes: ${scopes.join(", ")}).`);
}
