#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexHooksFile, buildCopilotHooksFile } from "../src/shared/hook-command.js";
import {
	writeConfigFileSyncNoFollow,
	writePrivateFileSyncNoFollow,
} from "../src/shared/private-file.js";

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
  package — \`npx @agentpulse/mcp serve\` / \`npx @agentpulse/mcp install\` work
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

	// AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
	// $AGENTPULSE_API_KEY from ITS OWN process environment, not the shell
	// that launched Claude Code — a GUI, IDE, or stale-terminal launch never
	// sources ~/.agentpulse/env, so the env-var form 401s silently there.
	// `setup` has no project-scope option (it always targets $HOME), so a
	// supplied key gets the literal, more-reliable form — acceptable because
	// settings.json is written with writePrivateFileSyncNoFollow below
	// (0600, no-follow) whenever a key is present, never world-readable. No
	// key at all (an auth-disabled server) keeps the env-var/allowedEnvVars
	// form. The value also still lands in ~/.agentpulse/env (0600) below
	// whenever one was supplied, for other consumers of it.
	const hookEntry = (agentType: string) =>
		key
			? {
					matcher: "",
					hooks: [
						{
							type: "http",
							url: `${url}/api/v1/hooks`,
							async: true,
							headers: { Authorization: `Bearer ${key}`, "X-Agent-Type": agentType },
						},
					],
				}
			: {
					matcher: "",
					hooks: [
						{
							type: "http",
							url: `${url}/api/v1/hooks`,
							async: true,
							allowedEnvVars: ["AGENTPULSE_API_KEY"],
							headers: { Authorization: "Bearer $AGENTPULSE_API_KEY", "X-Agent-Type": agentType },
						},
					],
				};

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

	const claudeSettingsContent = `${JSON.stringify(claudeSettings, null, 2)}\n`;
	if (key) {
		// H2: a literal key is embedded above, so the file is tightened to
		// 0600 and written no-follow (refuses a symlink at the destination
		// or its parent directory) — never world-readable.
		writePrivateFileSyncNoFollow(claudeSettingsPath, claudeSettingsContent);
	} else {
		writeFileSync(claudeSettingsPath, claudeSettingsContent);
	}
	console.log(`  ✓ Claude Code hooks → ${claudeSettingsPath}`);

	// ── Codex CLI ──
	// D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
	// $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.

	const codexDir = process.env.CODEX_HOME || join(process.env.HOME || "~", ".codex");
	mkdirSync(codexDir, { recursive: true });

	// D13 (F49): a direct installer with no --key, against a server that
	// requires auth, refuses before writing any command hooks.
	if (!key) {
		try {
			const meRes = await fetch(`${url}/api/v1/auth/me`);
			const me = (await meRes.json()) as { disableAuth?: boolean };
			if (me.disableAuth === false) {
				console.error("  ✗ This server requires an API key; pass --key (Hook ingest).");
				process.exit(1);
			}
		} catch {
			// Server unreachable: fall through and let the later health check
			// report it — this isn't the auth-refusal path.
		}
	}

	// D13/F57: below curl 7.55, `-H "@$f"` silently sends no auth header at all.
	if (key) {
		const curlVersion = Bun.spawnSync(["curl", "--version"]).stdout?.toString() ?? "";
		const versionMatch = curlVersion.match(/^curl (\d+)\.(\d+)\.(\d+)/);
		const [major, minor] = versionMatch
			? [Number(versionMatch[1]), Number(versionMatch[2])]
			: [0, 0];
		if (major < 7 || (major === 7 && minor < 55)) {
			const found = versionMatch ? versionMatch[0].replace(/^curl /, "") : "not found";
			console.error(
				`  ✗ AgentPulse direct hooks need curl >= 7.55 (found ${found}). Upgrade curl or use the relay installer.`,
			);
			process.exit(1);
		}

		// D13: the key never enters argv or the hooks file — the shim reads
		// it from this file at hook-fire time via curl -H "@$f".
		const agentpulseDir = join(process.env.HOME || "~", ".agentpulse");
		mkdirSync(agentpulseDir, { recursive: true });
		// F207: symlink-safe, fchmod-on-handle write — see
		// src/shared/private-file.ts for why a bare writeFileSync({mode})
		// isn't enough (the mode only applies on create, and the write
		// itself follows an existing symlink at the destination).
		const authHeaderPath = join(agentpulseDir, "hook-auth-header");
		writePrivateFileSyncNoFollow(authHeaderPath, `Authorization: Bearer ${key}\n`);
	}

	// check-hook-event-parity.ts's drift guard extracts this list (must stay
	// in lockstep with src/shared/types.ts's CodexEvent union); also used
	// below as a defensive floor on buildCodexHooksFile's output.
	const codexEvents = [
		"SessionStart",
		"SessionEnd",
		"PreToolUse",
		"PostToolUse",
		"UserPromptSubmit",
		"Stop",
		"Interrupt",
		"SubagentStart",
		"SubagentStop",
		"PermissionRequest",
		"PreCompact",
		"PostCompact",
	];

	const codexHooksPath = join(codexDir, "hooks.json");
	const newCodexHooksJson = buildCodexHooksFile({ baseUrl: url, direct: true });
	const newCodexHooksEvents = Object.keys(JSON.parse(newCodexHooksJson).hooks);
	if (
		newCodexHooksEvents.length !== codexEvents.length ||
		!codexEvents.every((e) => newCodexHooksEvents.includes(e))
	) {
		throw new Error(
			`buildCodexHooksFile() event set drifted from the expected ${codexEvents.length} CodexEvent members`,
		);
	}
	const unchanged =
		existsSync(codexHooksPath) && readFileSync(codexHooksPath, "utf-8") === newCodexHooksJson;
	if (unchanged) {
		console.log("  ✓ Codex hooks unchanged — no re-trust needed");
	} else {
		if (existsSync(codexHooksPath)) {
			const stamp = new Date()
				.toISOString()
				.replace(/[-:]/g, "")
				.replace(/\.\d{3}Z$/, "Z");
			const backupPath = `${codexHooksPath}.agentpulse-bak.${stamp}`;
			// F232: never write through a symlink at the destination or the
			// backup path — see src/shared/private-file.ts.
			writeConfigFileSyncNoFollow(backupPath, readFileSync(codexHooksPath, "utf-8"));
			console.log(`  ✓ Backed up existing Codex hooks to ${backupPath}`);
		}
		writeConfigFileSyncNoFollow(codexHooksPath, newCodexHooksJson);
		console.log(`  ✓ Codex CLI hooks  → ${codexHooksPath}`);
		console.log(
			"    Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks.",
		);
		console.log("    Re-trust after changing the AgentPulse URL or port.");
	}
	// D12: codex_hooks is a deprecated (but still-working) legacy alias for
	// [features].hooks — left alone if present, never newly written.

	// ── Copilot CLI ──
	// D8: only written when copilot is detected — never create config for a
	// tool that isn't installed.
	const homeDir = process.env.HOME || "~";
	if (Bun.which("copilot") || existsSync(join(homeDir, ".copilot"))) {
		// check-hook-event-parity.ts's drift guard extracts this list (must
		// stay in lockstep with src/shared/types.ts's CopilotEvent union);
		// also used below as a defensive floor on buildCopilotHooksFile's
		// output.
		const copilotEvents = [
			"sessionStart",
			"sessionEnd",
			"userPromptSubmitted",
			"postToolUse",
			"postToolUseFailure",
			"agentStop",
			"subagentStart",
			"subagentStop",
			"preCompact",
			"errorOccurred",
		];

		const copilotDir = join(homeDir, ".copilot", "hooks");
		mkdirSync(copilotDir, { recursive: true });
		const copilotHooksPath = join(copilotDir, "agentpulse.json");
		const newCopilotHooksJson = buildCopilotHooksFile({ baseUrl: url, direct: true });
		const newCopilotHooksEvents = Object.keys(JSON.parse(newCopilotHooksJson).hooks);
		if (
			newCopilotHooksEvents.length !== copilotEvents.length ||
			!copilotEvents.every((e) => newCopilotHooksEvents.includes(e))
		) {
			throw new Error(
				`buildCopilotHooksFile() event set drifted from the expected ${copilotEvents.length} CopilotEvent members`,
			);
		}
		const copilotUnchanged =
			existsSync(copilotHooksPath) &&
			readFileSync(copilotHooksPath, "utf-8") === newCopilotHooksJson;
		if (copilotUnchanged) {
			console.log("  ✓ Copilot hooks unchanged");
		} else {
			if (existsSync(copilotHooksPath)) {
				const stamp = new Date()
					.toISOString()
					.replace(/[-:]/g, "")
					.replace(/\.\d{3}Z$/, "Z");
				const backupPath = `${copilotHooksPath}.agentpulse-bak.${stamp}`;
				// F232: never write through a symlink at the destination or the
				// backup path — see src/shared/private-file.ts.
				writeConfigFileSyncNoFollow(backupPath, readFileSync(copilotHooksPath, "utf-8"));
				console.log(`  ✓ Backed up existing Copilot hooks to ${backupPath}`);
			}
			writeConfigFileSyncNoFollow(copilotHooksPath, newCopilotHooksJson);
			console.log(`  ✓ Copilot CLI hooks → ${copilotHooksPath}`);
		}
	}

	// ── Shell env (D37/F243) ──
	// The key itself no longer goes into the rc file — world-readable by
	// default on many systems, and the same key already gets 0600
	// treatment in hook-auth-header, so this was an inconsistency on the
	// key's most exposed path. Written to ~/.agentpulse/env (0600,
	// no-follow) instead, with only a key-free, idempotent source line in
	// the rc file.

	if (key) {
		const shell = process.env.SHELL || "/bin/zsh";
		const profile = shell.includes("zsh")
			? join(process.env.HOME || "~", ".zshrc")
			: join(process.env.HOME || "~", ".bashrc");

		let profileContent = "";
		try {
			profileContent = readFileSync(profile, "utf-8");
		} catch {}

		if (/^export AGENTPULSE_API_KEY=/m.test(profileContent)) {
			console.log(`  ! ${profile} already has a plaintext AGENTPULSE_API_KEY export from an`);
			console.log("    earlier install. Leaving it, but it's world-readable by default on");
			console.log("    many systems — remove it by hand:");
			console.log(`      sed -i.bak '/^export AGENTPULSE_API_KEY=/d' "${profile}"`);
		}

		const envDir = join(process.env.HOME || "~", ".agentpulse");
		mkdirSync(envDir, { recursive: true });
		const envPath = join(envDir, "env");
		writePrivateFileSyncNoFollow(
			envPath,
			`export AGENTPULSE_API_KEY="${key}"\nexport AGENTPULSE_URL="${url}"\n`,
		);
		console.log(`  ✓ Wrote AGENTPULSE_API_KEY/AGENTPULSE_URL to ${envPath} (0600)`);

		const sourceLine = '[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"';
		if (!profileContent.includes(sourceLine)) {
			writeConfigFileSyncNoFollow(
				profile,
				`${profileContent}\n# AgentPulse (key lives in ~/.agentpulse/env, not here)\n${sourceLine}\n`,
			);
			console.log(`  ✓ Added a source line for ~/.agentpulse/env to ${profile}`);
		}
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

	// This shim's own invocation surface (codex r2 CR3) — distinct from the
	// package's own default "agentpulse-mcp install" label, so error/usage
	// messages accurately describe how THIS process was actually run.
	const PROGRAM_LABEL = "agentpulse mcp install";

	let parsed: ReturnType<typeof parseInstallArgs>;
	try {
		parsed = parseInstallArgs(args.slice(2), PROGRAM_LABEL);
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
