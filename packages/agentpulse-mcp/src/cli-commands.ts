/**
 * The `install` and `--help` command implementations for this package's
 * bin (`cli.ts`) — split out of cli.ts (codex r2 CR1+CR2, reconcile pass
 * on thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md).
 *
 * This file is dynamically imported ONLY by cli.ts's `install`/`help`/
 * default branches — never by the `serve` branch, which imports `./index.js`
 * directly and nothing else. That module-graph separation is what makes
 * two invariants hold simultaneously:
 *
 *   1. (CR1) `agentpulse-mcp install`/`--help` never eagerly load the MCP
 *      SDK or any tool file — this module's own imports (client/errors/
 *      scopes/install) are exactly the four targeted modules bin/cli.ts's
 *      shim already isolates `mcp install` to, none of which import the
 *      SDK (verified in the 2026-07-23 campaign's Phase 3).
 *   2. (CR2) every `console.log` call this package's bin can ever reach
 *      lives here, not in cli.ts itself — so cli.ts (the module `serve`
 *      shares) can go back to containing ZERO stdout-writing calls, and
 *      check-no-console-log-mcp.ts no longer needs to allowlist the whole
 *      bin entrypoint, only this single-purpose, provably-serve-unreachable
 *      file.
 */
import { createHttpClient } from "./client.js";
import { mapError } from "./errors.js";
import { InstallArgsError, parseInstallArgs, resolveAuthKey, runInstall } from "./install.js";
import { ScopeDiscoveryError } from "./scopes.js";

const PROGRAM_LABEL = "agentpulse-mcp install";

export function printHelp(): void {
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

export async function runInstallCommand(args: string[]): Promise<void> {
	let parsed: ReturnType<typeof parseInstallArgs>;
	try {
		parsed = parseInstallArgs(args, PROGRAM_LABEL);
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
		const result = await runInstall(client, parsed, PROGRAM_LABEL);

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
