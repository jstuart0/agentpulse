#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { generateApiKey } from "../src/server/auth/api-key.js";

const args = process.argv.slice(2);
const command = args[0] || "start";

function printHelp() {
	console.log(`
  AgentPulse - Command center for AI coding agents across all your machines

  Usage:
    npx agentpulse              Start the server
    npx agentpulse setup        Configure Claude Code + Codex hooks
    npx agentpulse setup --url <url> --key <key>
    npx agentpulse --help       Show this help

  Environment variables:
    PORT              Server port (default: 3000)
    DATABASE_URL      PostgreSQL URL (default: SQLite)
    DISABLE_AUTH      Set "true" to skip auth
    AGENTPULSE_API_KEY  API key for hooks
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
		"SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "Stop",
		"SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "UserPromptSubmit",
	];

	const hooks: Record<string, unknown[]> = {};
	for (const event of claudeEvents) {
		hooks[event] = [hookEntry("claude_code")];
	}

	claudeSettings.hooks = {
		...(claudeSettings.hooks as Record<string, unknown> || {}),
		...hooks,
	};

	writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2) + "\n");
	console.log(`  ✓ Claude Code hooks → ${claudeSettingsPath}`);

	// ── Codex CLI ──

	const codexDir = join(process.env.HOME || "~", ".codex");
	mkdirSync(codexDir, { recursive: true });

	const codexEvents = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];
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
	writeFileSync(codexHooksPath, JSON.stringify({ hooks: codexHooks }, null, 2) + "\n");
	console.log(`  ✓ Codex CLI hooks  → ${codexHooksPath}`);

	// Enable hooks feature in codex config.toml
	const codexConfigPath = join(codexDir, "config.toml");
	if (existsSync(codexConfigPath)) {
		const content = readFileSync(codexConfigPath, "utf-8");
		if (!content.includes("codex_hooks")) {
			writeFileSync(codexConfigPath, content + "\n[features]\ncodex_hooks = true\n");
			console.log(`  ✓ Codex hooks enabled in config.toml`);
		}
	} else {
		writeFileSync(codexConfigPath, "[features]\ncodex_hooks = true\n");
		console.log(`  ✓ Codex config.toml created with hooks enabled`);
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
				profileContent +
					`\n# AgentPulse\nexport AGENTPULSE_API_KEY="${key}"\nexport AGENTPULSE_URL="${url}"\n`,
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

// ─── Router ─────────────────────────────────────────────────────────

switch (command) {
	case "setup":
		await setup();
		break;
	case "start":
		await start();
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
