/**
 * stdio entry point (AGEN-12 Phase 2, D3 seam 2 / plan step 6).
 *
 * Wired from `bin/cli.ts mcp serve`. All diagnostics go to stderr — the
 * stdio transport owns stdout for the JSON-RPC protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttpClient } from "./client.js";
import { stderrLog } from "./log.js";
import { discoverScopes } from "./scopes.js";
import { buildMcpServer } from "./server.js";

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
