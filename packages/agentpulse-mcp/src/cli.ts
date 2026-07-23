#!/usr/bin/env node
/**
 * `agentpulse-mcp` bin entry point (D6 of
 * thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md).
 *
 * Extracted from the main repo's `bin/cli.ts` `mcp()`/`mcpInstall()`
 * handlers (lines 249-338 pre-extraction) — subcommand dispatch, flag
 * handling (delegated to install.ts's `parseInstallArgs`), help text, exit
 * codes. No behavior change from the in-repo `agentpulse mcp serve|install`
 * commands beyond the one-level-shallower subcommand (`agentpulse-mcp
 * serve` instead of `agentpulse mcp serve`, since this package IS the MCP
 * server — there's no sibling `setup`/`start` command to disambiguate
 * against). Env vars unchanged: AGENTPULSE_URL (default
 * http://localhost:3000), AGENTPULSE_API_KEY.
 */
import { createHttpClient } from "./client.js";
import { mapError } from "./errors.js";
import { serveStdio } from "./index.js";
import { InstallArgsError, parseInstallArgs, resolveAuthKey, runInstall } from "./install.js";
import { ScopeDiscoveryError } from "./scopes.js";

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
	console.log(`
  agentpulse-mcp - Standalone MCP server for AgentPulse

  Usage:
    npx agentpulse-mcp serve      Start the MCP server (stdio)
    npx agentpulse-mcp install    Print MCP client config for Claude Code / Codex
    npx agentpulse-mcp --help     Show this help

  install flags:
    --key <existing key>   Reuse an existing API key (preflighted against
                            /auth/me for the required scope)
    --mint <name>           Mint a new key (default scope: observe;
                            read-only). Recommended.
    --orchestrate           Mint/require "manage" scope instead of the
                            observe-only default -- grants unattended full
                            operator control. Prints a mandatory warning.
    --url <url>             AgentPulse server URL (default: http://localhost:3000)

  Environment variables:
    AGENTPULSE_API_KEY  API key for \`serve\`, and (as a fallback auth
                        credential) \`install --mint\`
    AGENTPULSE_URL      AgentPulse server URL (default: http://localhost:3000)
`);
}

async function install(): Promise<void> {
	let parsed: ReturnType<typeof parseInstallArgs>;
	try {
		parsed = parseInstallArgs(args.slice(1));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	// Auth for the mint-or-preflight call itself: an explicit --key, else
	// AGENTPULSE_API_KEY (same fallback `serve` uses), else empty (only
	// viable under a server running with DISABLE_AUTH=true).
	const authKey = resolveAuthKey(parsed.key, process.env.AGENTPULSE_API_KEY);
	const client = createHttpClient({ baseUrl: parsed.url, apiKey: authKey });

	try {
		const result = await runInstall(client, parsed);

		console.log("");
		console.log("  AgentPulse MCP Install");
		console.log("  ───────────────────────");
		console.log("");
		console.log(`  Key scopes: ${result.scopes.join(", ")}`);
		console.log("");
		if (result.warning) {
			console.log(result.warning);
			console.log("");
		}
		console.log("  Claude Code -- one-shot registration (run this in your shell):");
		console.log("");
		console.log(`    ${result.claudeCommand}`);
		console.log("");
		console.log(
			"  Claude Code -- .mcp.json (project scope, commit-safe: uses ${AGENTPULSE_API_KEY} env expansion):",
		);
		console.log("");
		console.log(result.mcpJson);
		console.log("");
		console.log("  Codex CLI -- ~/.codex/config.toml:");
		console.log("");
		console.log(result.codexToml);
		console.log("");
		console.log(
			`  For the .mcp.json / config.toml blocks above, export AGENTPULSE_API_KEY="${result.keyRef}" in your shell before launching the client.`,
		);
		console.log("");
	} catch (err) {
		if (err instanceof ScopeDiscoveryError || err instanceof InstallArgsError) {
			console.error(err.message);
		} else {
			console.error(mapError(err, client.baseUrl).content[0].text);
		}
		process.exit(1);
	}
}

switch (command) {
	case "serve":
		await serveStdio();
		break;
	case "install":
		await install();
		break;
	case "--help":
	case "-h":
	case "help":
		printHelp();
		break;
	default:
		console.error(`Unknown command: ${command ?? "(none)"}`);
		printHelp();
		process.exit(1);
}
