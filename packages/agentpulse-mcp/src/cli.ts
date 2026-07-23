#!/usr/bin/env node
/**
 * `agentpulse-mcp` bin entry point (D6 of
 * thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md;
 * restructured into a pure dispatcher by the reconcile pass, codex r2
 * CR1+CR2).
 *
 * This module is ALWAYS loaded (it's the shebang'd entry point Node/Bun
 * execute directly), so it must never contain a `console.log`/stdout-write
 * call and must never statically import anything the `serve` subcommand
 * doesn't need — otherwise every invocation, including `install`/`--help`,
 * would eagerly pull in the MCP SDK and all 7 tool files before the
 * subcommand switch even runs.
 *
 *   - `serve` dynamic-imports `./index.js` ONLY — the one thing it needs.
 *   - `install`/`--help`/unknown-command dynamic-import `./cli-commands.js`
 *     ONLY — a separate module (never touched by the `serve` branch's
 *     import graph) that owns every console.log call this bin can reach,
 *     and internally imports the four targeted install-path modules
 *     (client/errors/scopes/install — mirroring bin/cli.ts's in-repo shim),
 *     none of which import the SDK.
 *
 * cli.test.ts statically asserts both properties so a regression here
 * fails a fast unit test, not just a manual proof.
 *
 * No behavior change from the in-repo `agentpulse mcp serve|install`
 * commands beyond the one-level-shallower subcommand (`agentpulse-mcp
 * serve` instead of `agentpulse mcp serve`, since this package IS the MCP
 * server — there's no sibling `setup`/`start` command to disambiguate
 * against). Env vars unchanged: AGENTPULSE_URL (default
 * http://localhost:3000), AGENTPULSE_API_KEY.
 *
 * `serve-http` (2026-07-23-deliver-agentpulse-mcp-integration, Phase 1)
 * dynamic-imports `./http.js` the same way `serve` imports `./index.js` --
 * exactly one branch, nothing statically pulled in for any other subcommand.
 * stdio (`serve`) is byte-for-byte unaffected by this addition.
 */

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
	case "serve": {
		const { serveStdio } = await import("./index.js");
		await serveStdio();
		break;
	}
	case "serve-http": {
		const { serveHttp } = await import("./http.js");
		await serveHttp();
		break;
	}
	case "install": {
		const { runInstallCommand } = await import("./cli-commands.js");
		await runInstallCommand(args.slice(1));
		break;
	}
	case "--help":
	case "-h":
	case "help": {
		const { printHelp } = await import("./cli-commands.js");
		printHelp();
		break;
	}
	default: {
		const { printHelp } = await import("./cli-commands.js");
		console.error(`Unknown command: ${command ?? "(none)"}`);
		printHelp();
		process.exit(1);
	}
}
