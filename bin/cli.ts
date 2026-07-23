#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0] || "start";

function printHelp() {
	console.log(`
  AgentPulse - Command center for AI coding agents across all your machines

  Usage:
    npx agentpulse              Start the server
    npx agentpulse setup        Configure Claude Code + Codex hooks
    npx agentpulse setup --url <url> --key <key>
    npx agentpulse mcp serve    Start the AgentPulse MCP server from this checkout (stdio)
    npx agentpulse mcp install  Print MCP client config for Claude Code / Codex
    npx agentpulse --help       Show this help

  Not running from a checkout? The MCP server also ships as a standalone
  package — \`npx agentpulse-mcp serve\` / \`npx agentpulse-mcp install\` work
  without cloning this repo. See packages/agentpulse-mcp/README.md.

  mcp install flags:
    --key <existing key>   Reuse an existing API key (preflighted against
                            /auth/me for the required scope)
    --mint <name>           Mint a new key (default scope: observe;
                            read-only). Recommended.
    --orchestrate           Mint/require "manage" scope instead of the
                            observe-only default -- grants unattended full
                            operator control. Prints a mandatory warning.
    --url <url>             AgentPulse server URL (default: http://localhost:3000)

  Environment variables:
    PORT                Server port (default: 3000)
    DATABASE_URL        PostgreSQL URL (default: SQLite)
    DISABLE_AUTH        Set "true" to skip auth
    AGENTPULSE_API_KEY  API key for hooks, \`mcp serve\`, and (as a fallback
                        auth credential) \`mcp install --mint\`
    AGENTPULSE_URL      AgentPulse server URL for \`mcp serve\` (default: http://localhost:3000)
`);
}

// ─── Setup Command ──────────────────────────────────────────────────

async function setup() {
	let url = "";
	let key = "";

	// Parse flags
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--url" && args[i + 1]) {
			url = args[++i];
		} else if (args[i] === "--key" && args[i + 1]) {
			key = args[++i];
		}
	}

	if (!url) url = "http://localhost:3000";

	console.log("");
	console.log("  AgentPulse Setup");
	console.log("  ────────────────");
	console.log("");

	// ── Claude Code ──

	const claudeSettingsPath = join(process.env.HOME || "~", ".claude", "settings.json");
	let claudeSettings: Record<string, unknown> = {};

	if (existsSync(claudeSettingsPath)) {
		try {
			claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		} catch {
			claudeSettings = {};
		}
	} else {
		mkdirSync(join(process.env.HOME || "~", ".claude"), { recursive: true });
	}

	const hookEntry = (agentType: string) => ({
		matcher: "",
		hooks: [
			{
				type: "http",
				url: `${url}/api/v1/hooks`,
				async: true,
				...(key
					? { headers: { Authorization: `Bearer ${key}`, "X-Agent-Type": agentType } }
					: {
							allowedEnvVars: ["AGENTPULSE_API_KEY"],
							headers: { Authorization: "Bearer $AGENTPULSE_API_KEY", "X-Agent-Type": agentType },
						}),
			},
		],
	});

	const claudeEvents = [
		"SessionStart",
		"SessionEnd",
		"PreToolUse",
		"PostToolUse",
		"Stop",
		"SubagentStart",
		"SubagentStop",
		"TaskCreated",
		"TaskCompleted",
		"UserPromptSubmit",
		"PermissionRequest",
		"PermissionDenied",
		"Notification",
		"PreCompact",
		"PostCompact",
		"PostToolUseFailure",
	];

	const hooks: Record<string, unknown[]> = {};
	for (const event of claudeEvents) {
		hooks[event] = [hookEntry("claude_code")];
	}

	claudeSettings.hooks = {
		...((claudeSettings.hooks as Record<string, unknown>) || {}),
		...hooks,
	};

	writeFileSync(claudeSettingsPath, `${JSON.stringify(claudeSettings, null, 2)}\n`);
	console.log(`  ✓ Claude Code hooks → ${claudeSettingsPath}`);

	// ── Codex CLI ──

	const codexDir = join(process.env.HOME || "~", ".codex");
	mkdirSync(codexDir, { recursive: true });

	const codexEvents = [
		"SessionStart",
		"PreToolUse",
		"PostToolUse",
		"UserPromptSubmit",
		"Stop",
		"SubagentStart",
		"SubagentStop",
		"PermissionRequest",
		"PreCompact",
		"PostCompact",
	];
	const codexHooks = codexEvents.map((event) => ({
		event,
		type: "http",
		url: `${url}/api/v1/hooks`,
		async: true,
		headers: {
			Authorization: key ? `Bearer ${key}` : "Bearer $AGENTPULSE_API_KEY",
			"X-Agent-Type": "codex_cli",
		},
	}));

	const codexHooksPath = join(codexDir, "hooks.json");
	writeFileSync(codexHooksPath, `${JSON.stringify({ hooks: codexHooks }, null, 2)}\n`);
	console.log(`  ✓ Codex CLI hooks  → ${codexHooksPath}`);

	// Hooks are stable and enabled by default since codex-cli 0.124.0;
	// codex_hooks is a recognized legacy alias for the `hooks` feature,
	// written for compatibility with older codex-cli installs that still
	// gate on it.
	const codexConfigPath = join(codexDir, "config.toml");
	if (existsSync(codexConfigPath)) {
		const content = readFileSync(codexConfigPath, "utf-8");
		if (!content.includes("codex_hooks")) {
			writeFileSync(codexConfigPath, `${content}\n[features]\ncodex_hooks = true\n`);
			console.log("  ✓ Codex hooks enabled in config.toml");
		}
	} else {
		writeFileSync(codexConfigPath, "[features]\ncodex_hooks = true\n");
		console.log("  ✓ Codex config.toml created with hooks enabled");
	}

	// ── Shell env ──

	if (key) {
		const shell = process.env.SHELL || "/bin/zsh";
		const profile = shell.includes("zsh")
			? join(process.env.HOME || "~", ".zshrc")
			: join(process.env.HOME || "~", ".bashrc");

		let profileContent = "";
		try {
			profileContent = readFileSync(profile, "utf-8");
		} catch {}

		let added = false;
		if (!profileContent.includes("AGENTPULSE_API_KEY")) {
			writeFileSync(
				profile,
				`${profileContent}\n# AgentPulse\nexport AGENTPULSE_API_KEY="${key}"\nexport AGENTPULSE_URL="${url}"\n`,
			);
			added = true;
		}
		console.log(added ? `  ✓ Env vars added to ${profile}` : `  ✓ Env vars already in ${profile}`);
	}

	// ── Verify ──

	console.log("");
	try {
		const res = await fetch(`${url}/api/v1/health`);
		if (res.ok) {
			console.log(`  ✓ Server reachable at ${url}`);

			// Send test event
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-Agent-Type": "claude_code",
			};
			if (key) headers.Authorization = `Bearer ${key}`;

			const testRes = await fetch(`${url}/api/v1/hooks`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					session_id: `setup-test-${Date.now()}`,
					hook_event_name: "SessionStart",
					cwd: process.cwd(),
					source: "setup-cli",
				}),
			});
			if (testRes.ok) {
				console.log("  ✓ Test event sent successfully");
			}
		}
	} catch {
		console.log(`  ! Server not reachable at ${url} (start it first)`);
	}

	console.log("");
	console.log("  Done! Start a new Claude Code or Codex session to see it in AgentPulse.");
	if (!key) {
		console.log("  Note: Set AGENTPULSE_API_KEY in your shell if your server requires auth.");
	}
	console.log("");
}

// ─── Start Command ──────────────────────────────────────────────────

async function start() {
	// Just import and run the server
	await import("../src/server/index.js");
}

// ─── MCP Command (thin shim over the agentpulse-mcp package — D2 of
// thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md) ──

async function mcp() {
	const subcommand = args[1];
	switch (subcommand) {
		case "serve": {
			const { serveStdio } = await import("../packages/agentpulse-mcp/src/index.js");
			await serveStdio();
			break;
		}
		case "install":
			await mcpInstall();
			break;
		default:
			console.error(`Unknown mcp subcommand: ${subcommand ?? "(none)"}`);
			console.error("Usage: agentpulse mcp serve | agentpulse mcp install");
			process.exit(1);
	}
}

async function mcpInstall() {
	// Four TARGETED dynamic imports, pointed at the package's individual
	// source files rather than its index.js barrel (dexter G1 — binding).
	// Going through index.js would make `agentpulse mcp install` eagerly
	// load the full MCP SDK + all 7 tool files it never touches (a startup
	// regression), and a bad top-level schema in any tool file would then
	// break `install`, which is isolated from that failure domain today.
	const { createHttpClient } = await import("../packages/agentpulse-mcp/src/client.js");
	const { mapError } = await import("../packages/agentpulse-mcp/src/errors.js");
	const { ScopeDiscoveryError } = await import("../packages/agentpulse-mcp/src/scopes.js");
	const { InstallArgsError, parseInstallArgs, resolveAuthKey, runInstall } = await import(
		"../packages/agentpulse-mcp/src/install.js"
	);

	let parsed: ReturnType<typeof parseInstallArgs>;
	try {
		parsed = parseInstallArgs(args.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	// Auth for the mint-or-preflight call itself: an explicit --key, else
	// AGENTPULSE_API_KEY (same fallback `mcp serve` uses), else empty (only
	// viable under DISABLE_AUTH=true).
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

// ─── Router ─────────────────────────────────────────────────────────

switch (command) {
	case "setup":
		await setup();
		break;
	case "start":
		await start();
		break;
	case "mcp":
		await mcp();
		break;
	case "--help":
	case "-h":
	case "help":
		printHelp();
		break;
	default:
		console.error(`Unknown command: ${command}`);
		printHelp();
		process.exit(1);
}
