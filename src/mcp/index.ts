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
