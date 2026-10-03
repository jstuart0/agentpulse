#!/usr/bin/env bun

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { addExcludeRule } from "../src/shared/exclude-rules-write.js";
import {
	type ExcludeDecisionReason,
	evaluateExclusion,
	homeMismatchWarning,
	loadExcludeRules,
	rulesCountWarning,
	setInvalidMarker,
} from "../src/shared/exclude-rules.js";
import {
	type ExcludeScriptKind,
	type ExcludeScriptState,
	excludeScriptPath,
	inspectExcludeScript,
	installExcludeScript,
} from "../src/shared/exclude-script.js";
import {
	buildBashExcludeScript,
	buildCodexHooksFile,
	buildCopilotHooksFile,
} from "../src/shared/hook-command.js";
import {
	CODEX_APPROVE_LINE,
	CODEX_REAPPROVE_LINE,
	EXCLUDE_CHECK_HINT,
	EXCLUDE_RULES_RELATIVE_PATH,
	EXCLUDE_SCRIPT_SEND_STATUS,
	STATUSLINE_OFFER_LINE,
	SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH,
} from "../src/shared/hook-headers.js";
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
    npx agentpulse setup --statusline   Also install the Claude Code statusline (off by default)
    npx agentpulse mcp serve    Start the AgentPulse MCP server from this checkout (stdio)
    npx agentpulse mcp install  Print MCP client config for Claude Code / Codex
    npx agentpulse exclude check [dir]   Report whether [dir] (default: cwd) is excluded
    npx agentpulse exclude add <dir>     Add a directory to ~/.agentpulse/exclude
    npx agentpulse exclude list          List the current exclude rules
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
	const home = resolveHomeOrExit("setup");
	let url = "";
	let key = "";
	let withStatusline = false;
	let codexHooksWritten: "new" | "updated" | null = null;

	// Parse flags
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--url" && args[i + 1]) {
			url = args[++i];
		} else if (args[i] === "--key" && args[i + 1]) {
			key = args[++i];
		} else if (args[i] === "--statusline") {
			withStatusline = true;
		}
	}

	if (!url) url = "http://localhost:3000";

	console.log("");
	console.log("  AgentPulse Setup");
	console.log("  ────────────────");
	console.log("");

	// ── Claude Code ──

	const claudeSettingsPath = join(home, ".claude", "settings.json");
	let claudeSettings: Record<string, unknown> = {};

	if (existsSync(claudeSettingsPath)) {
		try {
			claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		} catch {
			claudeSettings = {};
		}
	} else {
		mkdirSync(join(home, ".claude"), { recursive: true });
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
							allowedEnvVars: ["AGENTPULSE_SKIP"],
							headers: {
								Authorization: `Bearer ${key}`,
								"X-Agent-Type": agentType,
								"X-AgentPulse-Skip": "$AGENTPULSE_SKIP",
							},
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
							allowedEnvVars: ["AGENTPULSE_API_KEY", "AGENTPULSE_SKIP"],
							headers: {
								Authorization: "Bearer $AGENTPULSE_API_KEY",
								"X-Agent-Type": agentType,
								"X-AgentPulse-Skip": "$AGENTPULSE_SKIP",
							},
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
		try {
			writePrivateFileSyncNoFollow(claudeSettingsPath, claudeSettingsContent);
		} catch (err) {
			console.error(
				`  ✗ Claude Code hooks not written: ${claudeSettingsPath} could not be written with a literal key (${err instanceof Error ? err.message : String(err)}).`,
			);
			if (lstatSync(claudeSettingsPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
				console.error(
					"    settings.json is a symbolic link, and a key is never written through a link. Run setup without --key (the hooks then read the key from your environment), or replace the link with a regular file.",
				);
			}
			process.exit(1);
		}
	} else {
		writeFileSync(claudeSettingsPath, claudeSettingsContent);
	}
	console.log(`  ✓ Claude Code hooks → ${claudeSettingsPath}`);
	installOrOfferStatusline(home, claudeSettingsPath, withStatusline, Boolean(key));

	// ── Codex CLI ──
	// D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
	// $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.

	const codexDir = process.env.CODEX_HOME || join(home, ".codex");
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
		const agentpulseDir = join(home, ".agentpulse");
		mkdirSync(agentpulseDir, { recursive: true, mode: 0o700 });
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

	installExcludeScriptWithMessage(home);

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
		const hadHooks = existsSync(codexHooksPath);
		if (hadHooks) {
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
		codexHooksWritten = hadHooks ? "updated" : "new";
	}
	console.log(`    ${EXCLUDE_CHECK_HINT}`);
	// D12: codex_hooks is a deprecated (but still-working) legacy alias for
	// [features].hooks — left alone if present, never newly written.

	// ── Copilot CLI ──
	// D8: only written when copilot is detected — never create config for a
	// tool that isn't installed.
	const homeDir = home;
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
		console.log(`    ${EXCLUDE_CHECK_HINT}`);
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
		const profile = shell.includes("zsh") ? join(home, ".zshrc") : join(home, ".bashrc");

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

		const envDir = join(home, ".agentpulse");
		mkdirSync(envDir, { recursive: true, mode: 0o700 });
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
	if (codexHooksWritten === "new") console.log(`  ${CODEX_APPROVE_LINE}`);
	else if (codexHooksWritten === "updated") console.log(`  ${CODEX_REAPPROVE_LINE}`);
}

/**
 * True where the hooks run the PowerShell check (Windows). The environment switch is
 * for tests only: it lets the Windows branch run on a host that isn't Windows.
 */
function wantsPowerShellCheck(): boolean {
	return process.platform === "win32" || process.env.AGENTPULSE_TEST_FORCE_PS_SCRIPT === "1";
}

/** Installs or refreshes the check scripts (the shell one, plus the PowerShell twin on Windows) and says what happened; a refusal is a warning, never a failure. */
function installExcludeScriptWithMessage(home: string): void {
	const kinds: ExcludeScriptKind[] = wantsPowerShellCheck() ? ["sh", "ps1"] : ["sh"];
	for (const kind of kinds) {
		const result = installExcludeScript(home, undefined, kind);
		if (result.status === "installed") {
			console.log(`  ✓ Exclusion check → ${result.path}`);
		} else if (result.status === "skipped") {
			console.log(`  ! Exclusion check not installed: ${result.message}`);
			console.log(
				"    Hooks still send as before until you add exclude rules; with a rules file present they send nothing until the check is installed.",
			);
		}
	}
}

/**
 * `--statusline`: copies scripts/statusline.sh to ~/.claude and enables it
 * when settings.json has no statusLine yet (someone else's is never
 * replaced). Without the flag it prints the one line saying the statusline
 * exists.
 */
function installOrOfferStatusline(
	home: string,
	settingsPath: string,
	install: boolean,
	privateSettings: boolean,
) {
	if (!install) {
		console.log(`    ${STATUSLINE_OFFER_LINE}`);
		return;
	}
	const source = join(import.meta.dir, "..", "scripts", "statusline.sh");
	if (!existsSync(source)) {
		console.log(
			"    Statusline: scripts/statusline.sh is not in this install; use the relay installer.",
		);
		return;
	}
	const dest = join(home, ".claude", "statusline-agentpulse.sh");
	writeConfigFileSyncNoFollow(dest, readFileSync(source, "utf-8"));
	chmodSync(dest, 0o755);
	const want = { type: "command", command: "~/.claude/statusline-agentpulse.sh" };
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		console.log(
			`  ✓ Statusline installed at ${dest}; ${settingsPath} could not be read, so it was left alone.`,
		);
		return;
	}
	const existing = settings.statusLine as { command?: string } | undefined;
	if (existing && existing.command !== want.command) {
		console.log(
			`  ✓ Statusline installed at ${dest}; your settings.json already has a statusLine, so it was left alone.`,
		);
		return;
	}
	settings.statusLine = want;
	const content = `${JSON.stringify(settings, null, 2)}\n`;
	try {
		if (privateSettings) writePrivateFileSyncNoFollow(settingsPath, content);
		else writeFileSync(settingsPath, content);
	} catch (err) {
		console.log(
			`  ✓ Statusline installed at ${dest}; ${settingsPath} could not be updated (${err instanceof Error ? err.message : String(err)}), so it was left alone.`,
		);
		return;
	}
	console.log(`  ✓ Statusline installed and enabled (${dest})`);
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

// ─── Exclude Command ────────────────────────────────────────────────
// `agentpulse exclude check|add|list` — lets a user check, add, and list
// the directories whose sessions are excluded from being reported.

/**
 * HOME, else USERPROFILE. With neither set the old code fell back to a
 * literal "~" (a non-existent, non-absolute path that silently made every
 * subcommand operate on the wrong place); this fails loudly instead.
 */
function resolveHomeOrExit(command: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		console.error(
			`agentpulse ${command}: neither HOME nor USERPROFILE is set, so there is no home directory to work in.`,
		);
		process.exit(1);
	}
	return home;
}

/**
 * The account's home as the operating system's user database has it (not HOME), for the warning about
 * rules this command's own HOME never reads. AGENTPULSE_TEST_ACCOUNT_HOME stands in for it in tests
 * only, so a test never looks at the real account's directory.
 */
function accountHomeForCheck(): string | undefined {
	const forTests = process.env.AGENTPULSE_TEST_ACCOUNT_HOME;
	if (forTests) return forTests;
	try {
		return userInfo().homedir;
	} catch {
		return undefined;
	}
}

function resolveExcludeHome(): string {
	return resolveHomeOrExit("exclude");
}

// Overridable for tests — never the real locally-running relay. Defaults
// to the relay's own real default port (scripts/relay.ts's DEFAULT_PORT).
const RELAY_LOCAL_URL = process.env.AGENTPULSE_RELAY_LOCAL_URL || "http://localhost:4000";

function printExcludeHelp() {
	console.log(`
  Usage:
    agentpulse exclude check [dir]   Report whether [dir] (default: cwd) is excluded
    agentpulse exclude add <dir>     Add a directory to ~/.agentpulse/exclude
    agentpulse exclude list          List the current rules

  Flags (check only):
    --json       Machine-readable output
`);
}

/**
 * Test-only seam — when
 * AGENTPULSE_TEST_FORCE_SHELL_RESULT is "0" or "1", excludeCheck uses
 * that as the shell evaluator's verdict instead of actually running the
 * generated shell snippet, letting a test force a TypeScript/shell
 * disagreement deterministically and assert the exit code (2) and
 * message that path produces. This is the ONLY legitimate read site for
 * this env var — guarded by
 * scripts/check-no-exclude-provider-outside-tests.ts, which fails CI if
 * any other non-test file references it.
 */
function resolveForcedShellResultForTests(): boolean | undefined {
	const raw = process.env.AGENTPULSE_TEST_FORCE_SHELL_RESULT;
	if (raw === "1") return true;
	if (raw === "0") return false;
	return undefined;
}

/**
 * Runs the installed check for real (the same `/bin/sh <script>` the hook
 * command runs), against the same home/cwd/skip, and reports its verdict, so
 * `exclude check` can cross-check the TypeScript evaluator's answer against
 * the shell one and flag a disagreement loudly. When no trusted copy is
 * installed it runs this version's generated text instead, so the comparison
 * still happens. Exit 42 = send (not excluded); any other status = nothing is sent.
 */
function runShellExcludeCheck(
	home: string,
	cwd: string,
	skip: string | undefined,
	script: ExcludeScriptState,
): boolean | null {
	const installedAndTrusted = script.state === "current" || script.state === "stale";
	// The hook names /bin/sh; Windows has no such path, and its PowerShell hooks
	// run the PowerShell twin instead, so there the cross-check uses whatever sh is on PATH.
	const interpreter = process.platform === "win32" ? "sh" : "/bin/sh";
	const argv = installedAndTrusted
		? [interpreter, excludeScriptPath(home)]
		: [interpreter, "-c", buildBashExcludeScript()];
	let result: ReturnType<typeof Bun.spawnSync>;
	try {
		result = Bun.spawnSync(argv, {
			cwd,
			env: { ...process.env, HOME: home, AGENTPULSE_SKIP: skip ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch {
		return null;
	}
	// Only the dedicated "send" status means not excluded; a script that exits any other
	// way (0 from an empty or truncated file, 2 from a syntax error) sends nothing.
	if (result.exitCode === EXCLUDE_SCRIPT_SEND_STATUS) return false;
	return result.exitCode === null ? null : true;
}

/**
 * The Relay row. "enforced" only when the running relay answers the check
 * endpoint (an older relay 404s it). When the answer carries a verdict, it is
 * compared with this command's own: a relay whose embedded evaluator
 * disagrees is not enforcing what the rules file says, and the row says so.
 */
async function probeRelayRow(cwd: string, cliExcluded: boolean): Promise<string> {
	try {
		const res = await fetch(
			`${RELAY_LOCAL_URL}/api/v1/relay/exclude-check?cwd=${encodeURIComponent(cwd)}`,
			{ signal: AbortSignal.timeout(1500) },
		);
		if (!res.ok) {
			return "not enforced: the running relay predates exclude rules; restart or reinstall it";
		}
		const body = (await res.json().catch(() => null)) as { excluded?: unknown } | null;
		if (typeof body?.excluded === "boolean" && body.excluded !== cliExcluded) {
			const word = (excluded: boolean) => (excluded ? "excluded" : "not excluded");
			return `not enforced: the running relay and this command disagree about this directory (relay: ${word(body.excluded)}; this command: ${word(cliExcluded)}); reinstall the relay`;
		}
		return "enforced";
	} catch {
		return "not enforced: no relay is running on this machine";
	}
}

function probeSupervisorRow(home: string): string {
	const stampPath = join(home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH);
	const NOT_DETECTED = "not detected: if a supervisor runs here, restart it on a current version";
	if (!existsSync(stampPath)) return NOT_DETECTED;
	try {
		const ageMs = Date.now() - statSync(stampPath).mtimeMs;
		if (ageMs > 5 * 60 * 1000) return NOT_DETECTED;
		return supervisorStampBlamesSavedState(stampPath)
			? "enforced, but the supervisor is sending nothing: its saved state file can't be trusted (see the supervisor log)"
			: "enforced";
	} catch {
		return NOT_DETECTED;
	}
}

/** Whether the supervisor's stamp says its saved gate state, not the exclude file, is why it fails closed. */
function supervisorStampBlamesSavedState(stampPath: string): boolean {
	try {
		const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as {
			rulesState?: unknown;
			cause?: unknown;
		};
		return stamp.rulesState === "invalid" && stamp.cause === "state_file";
	} catch {
		return false;
	}
}

const SCRIPT_FIX_HINT = "run `agentpulse setup` (or `agentpulse exclude add`)";
const CODEX_APPROVAL_NOTE = "(Codex only runs hooks you have approved: run /hooks in Codex)";

/** A plain-words status for the installed check script, or null when it is current. */
function scriptProblem(script: ExcludeScriptState): string | null {
	switch (script.state) {
		case "current":
			return null;
		case "missing":
			return `not enforced: the check script is missing (${script.path}): ${SCRIPT_FIX_HINT}`;
		case "stale":
			return `not enforced: the check script is out of date (${script.path}): ${SCRIPT_FIX_HINT}`;
		case "untrusted":
			return `not enforced: the check script can't be trusted (${script.reason}): ${SCRIPT_FIX_HINT}`;
	}
}

/**
 * Shared by the Codex and Copilot rows: the installed hook file must carry the
 * gate that runs the check script (a file from before the feature, or a
 * missing one, truthfully reports "not enforced"), and the script itself must
 * be installed, current and trusted: with a rules file present the hooks send
 * nothing without it.
 */
function probeCommandHookRow(
	hooksFilePath: string,
	script: ExcludeScriptState,
	scriptPs: ExcludeScriptState | null = null,
): string {
	if (!existsSync(hooksFilePath))
		return `not enforced: ${SCRIPT_FIX_HINT.replace("run ", "re-run ")}`;
	let content: string;
	try {
		content = readFileSync(hooksFilePath, "utf-8");
	} catch {
		return `not enforced: ${SCRIPT_FIX_HINT.replace("run ", "re-run ")}`;
	}
	if (!content.includes("exclude-check.sh") && !content.includes("exclude-check.ps1")) {
		return `not enforced: the installed hooks predate exclude rules: ${SCRIPT_FIX_HINT}`;
	}
	// Hooks that run the PowerShell twin depend on that file, not the shell one.
	const runsPowerShell = content.includes("exclude-check.ps1");
	return scriptProblem(runsPowerShell && scriptPs ? scriptPs : script) ?? "enforced";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The path every AgentPulse hook posts to; any other HTTP hook in settings.json is someone else's. */
const AGENTPULSE_HOOKS_PATH = "/api/v1/hooks";

/**
 * Which way Claude Code reports: through the local relay or straight to a
 * server. Only hooks aimed at the AgentPulse hooks path count (an unrelated
 * HTTP hook listed first says nothing about AgentPulse). Decided from the
 * hook's own URL and key form, never from `allowedEnvVars` (every hook form
 * lists the skip variable there): a loopback URL that carries no
 * Authorization header is the relay (the relay adds the key itself); anything
 * else, including a loopback URL that does carry a key (a server running on
 * this machine), is direct.
 *
 * Claude Code runs the hooks of every settings level together, so all of them
 * count, exactly as the statusline reads them: the user's settings (in
 * CLAUDE_CONFIG_DIR when that is set and not empty, else ~/.claude) and the
 * project directory's `.claude/settings.json` and `.claude/settings.local.json`.
 * Any one that cannot be read as JSON means the hooks are not known
 * ("unreadable"); otherwise one direct hook makes it "direct", then "relay".
 */
function detectClaudeMode(
	home: string,
	projectDir: string,
): "direct" | "relay" | "none" | "unreadable" {
	const userDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	const files = [
		join(userDir, "settings.json"),
		join(projectDir, ".claude", "settings.json"),
		join(projectDir, ".claude", "settings.local.json"),
	];
	const modes = files.map(claudeModeOfFile);
	if (modes.includes("unreadable")) return "unreadable";
	if (modes.includes("direct")) return "direct";
	return modes.includes("relay") ? "relay" : "none";
}

function claudeModeOfFile(settingsPath: string): "direct" | "relay" | "none" | "unreadable" {
	if (!existsSync(settingsPath)) return "none";
	let content: string;
	let settings: { hooks?: Record<string, unknown> };
	try {
		content = readFileSync(settingsPath, "utf-8");
		settings = JSON.parse(content) as { hooks?: Record<string, unknown> };
	} catch {
		return "unreadable";
	}
	if (content.includes("hook-auth-header")) return "direct";
	let mode: "direct" | "relay" | "none" = "none";
	for (const entries of Object.values(settings?.hooks ?? {})) {
		for (const entry of Array.isArray(entries) ? entries : []) {
			for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
				if (hook?.type !== "http" || typeof hook.url !== "string") continue;
				let parsed: URL;
				try {
					parsed = new URL(hook.url);
				} catch {
					continue;
				}
				if (parsed.pathname !== AGENTPULSE_HOOKS_PATH) continue;
				const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
				const headers = (hook.headers ?? {}) as Record<string, unknown>;
				const hasKey = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
				if (!loopback || hasKey) return "direct";
				mode = "relay";
			}
		}
	}
	return mode;
}

/** True when anything (a file, a link, a directory) sits at the rules path: the hooks then hand the decision to the check script. */
function rulesFileExists(home: string): boolean {
	try {
		lstatSync(join(home, EXCLUDE_RULES_RELATIVE_PATH));
		return true;
	} catch {
		return false;
	}
}

function codexStatus(
	hooksFilePath: string,
	script: ExcludeScriptState,
	scriptPs: ExcludeScriptState | null,
): string {
	const status = probeCommandHookRow(hooksFilePath, script, scriptPs);
	return status === "enforced" ? `enforced ${CODEX_APPROVAL_NOTE}` : status;
}

interface SenderRow {
	sender: string;
	mode: string;
	status: string;
}

async function buildSenderTable(
	home: string,
	cwd: string,
	cliExcluded: boolean,
	rulesInvalid: boolean,
	script: ExcludeScriptState,
	scriptPs: ExcludeScriptState | null,
): Promise<SenderRow[]> {
	const relayStatus = await probeRelayRow(cwd, cliExcluded);
	const relayEnforced = relayStatus === "enforced";
	const codexHooksPath = process.env.CODEX_HOME
		? join(process.env.CODEX_HOME, "hooks.json")
		: join(home, ".codex", "hooks.json");
	const copilotHooksPath = join(home, ".copilot", "hooks", "agentpulse.json");
	const claudeMode = detectClaudeMode(home, cwd);

	const rows: SenderRow[] = [
		{ sender: "Relay", mode: "relay", status: relayStatus },
		{ sender: "Supervisor", mode: "supervisor", status: probeSupervisorRow(home) },
		{ sender: "Codex CLI", mode: "hooks", status: codexStatus(codexHooksPath, script, scriptPs) },
		{
			sender: "Copilot CLI",
			mode: "hooks",
			status: probeCommandHookRow(copilotHooksPath, script, scriptPs),
		},
	];

	if (claudeMode === "unreadable") {
		rows.push({
			sender: "Claude Code",
			mode: "?",
			status:
				"not known: ~/.claude/settings.json could not be read as JSON, so its hooks can't be checked",
		});
	} else if (claudeMode === "direct") {
		rows.push({
			sender: "Claude Code",
			mode: "direct",
			status: rulesInvalid
				? "STILL REPORTING: rules can't be applied in direct mode"
				: "path rules not applied; AGENTPULSE_SKIP is honoured by the server (the request still leaves this machine)",
		});
	} else if (claudeMode === "relay") {
		rows.push({
			sender: "Claude Code",
			mode: "relay",
			status: relayEnforced ? "enforced" : relayStatus,
		});
	}

	return rows;
}

function formatTable(rows: SenderRow[]): string {
	const lines = ["", "    Sender        Mode     Status"];
	for (const row of rows) {
		lines.push(`    ${row.sender.padEnd(13)} ${row.mode.padEnd(8)} ${row.status}`);
	}
	return lines.join("\n");
}

function reasonText(reason: ExcludeDecisionReason): string {
	switch (reason) {
		case "env":
			return "AGENTPULSE_SKIP";
		case "path":
			return "a matching directory rule";
		case "rules_invalid":
			return "the rules file is invalid";
		case "no_cwd":
			return "the working directory could not be determined";
		default:
			return "no rule matched";
	}
}

async function excludeCheck(dirArg: string | undefined) {
	const jsonMode = args.includes("--json");
	const targetDir = resolve(dirArg && dirArg.length > 0 ? dirArg : process.cwd());
	const skip = process.env.AGENTPULSE_SKIP;
	const home = resolveExcludeHome();

	const loaded = loadExcludeRules(home);
	const tsResult = evaluateExclusion({ cwd: targetDir, skip, rules: loaded });
	const script = inspectExcludeScript(home);
	const scriptPs = wantsPowerShellCheck() ? inspectExcludeScript(home, undefined, "ps1") : null;
	const shellExcluded =
		resolveForcedShellResultForTests() ?? runShellExcludeCheck(home, targetDir, skip, script);

	if (shellExcluded !== null && shellExcluded !== tsResult.excluded) {
		console.error(
			`agentpulse exclude check: the TypeScript and shell evaluators disagree on ${targetDir} (TypeScript: ${tsResult.excluded ? "excluded" : "not excluded"}, shell: ${shellExcluded ? "excluded" : "not excluded"}). This is a bug in AgentPulse — please report it.`,
		);
		process.exit(2);
	}

	setInvalidMarker(home, loaded.state === "invalid");
	const homeWarning = homeMismatchWarning(home, accountHomeForCheck());
	const table = await buildSenderTable(
		home,
		targetDir,
		tsResult.excluded,
		loaded.state === "invalid",
		script,
		scriptPs,
	);

	if (jsonMode) {
		console.log(
			JSON.stringify(
				{
					dir: targetDir,
					excluded: tsResult.excluded,
					reason: tsResult.reason,
					rule: tsResult.rule,
					line: tsResult.line,
					rulesState: loaded.state,
					homeWarning,
					rulesReason: loaded.reason,
					rulesLine: loaded.line,
					mode: loaded.mode,
					mtimeMs: loaded.mtimeMs,
					resolvedPath: loaded.resolvedPath,
					script,
					...(scriptPs ? { scriptPowerShell: scriptPs } : {}),
					senders: table,
				},
				null,
				2,
			),
		);
	} else {
		console.log("");
		if (loaded.state === "invalid") {
			console.log(
				`  RULES INVALID  ${loaded.resolvedPath ?? join(home, EXCLUDE_RULES_RELATIVE_PATH)}` +
					`${loaded.line !== undefined ? ` line ${loaded.line}` : ""}:`,
			);
			console.log(`    ${loaded.reason}`);
		} else if (tsResult.excluded) {
			console.log(`  EXCLUDED  ${targetDir}`);
			console.log(`    reason: ${reasonText(tsResult.reason)}`);
			if (tsResult.rule) console.log(`    rule: ${tsResult.rule} (line ${tsResult.line})`);
		} else {
			console.log(`  NOT EXCLUDED  ${targetDir}`);
		}
		console.log(formatTable(table));
		console.log("");
		for (const row of table) {
			if (!/^enforced\b/i.test(row.status) && !row.status.startsWith("STILL REPORTING")) {
				console.log(`  warning: ${row.sender}: ${row.status}`);
			}
		}
		if (rulesFileExists(home) && (scriptProblem(script) || (scriptPs && scriptProblem(scriptPs)))) {
			console.log(
				`  warning: a rules file exists but the check script is not usable, so Codex and Copilot hooks send NOTHING (they fail closed) until it is installed: ${SCRIPT_FIX_HINT}.`,
			);
		}
		if (homeWarning) console.log(`  warning: ${homeWarning}`);
		const countWarning = rulesCountWarning(loaded.rules.length);
		if (countWarning) console.log(`  ${countWarning}`);
	}

	if (loaded.state === "invalid") process.exit(2);
	process.exit(tsResult.excluded ? 0 : 1);
}

function excludeAdd(dirArg: string | undefined) {
	if (!dirArg) {
		console.error("Usage: agentpulse exclude add <dir>");
		process.exit(1);
	}
	let result: ReturnType<typeof addExcludeRule>;
	try {
		result = addExcludeRule(resolveExcludeHome(), dirArg);
	} catch (err) {
		// No stack trace on any refusal — anything that reaches here is an
		// OS-level failure the writer didn't already turn into a clean message.
		console.error(`agentpulse exclude add: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	if (result.status === "refused") {
		console.error(`agentpulse exclude add: ${result.message}`);
		process.exit(1);
	}
	// Someone who pasted hook config from the Setup page has no check script yet;
	// installing it here is what makes the rule they just added take effect.
	const homeForScript = resolveExcludeHome();
	if (result.status === "present") {
		console.log(`  ${result.rule} is already excluded (${result.path}).`);
		installExcludeScriptWithMessage(homeForScript);
		return;
	}
	console.log(`  ✓ Added ${result.rule} to ${result.path}`);
	installExcludeScriptWithMessage(homeForScript);
	console.log("");
	console.log("  Applies to new events. Sessions already reported are not removed.");
	console.log(
		"  A running session that moves into this directory will look stalled on the dashboard.",
	);
}

function excludeList() {
	const home = resolveExcludeHome();
	const loaded = loadExcludeRules(home);
	const resolvedPath = loaded.resolvedPath ?? join(home, EXCLUDE_RULES_RELATIVE_PATH);
	console.log(`  Rules file: ${resolvedPath}`);
	console.log("");

	if (loaded.state === "none") {
		console.log("  (no rules)");
		return;
	}
	if (loaded.state === "invalid") {
		console.error(
			`  RULES INVALID${loaded.line !== undefined ? ` (line ${loaded.line})` : ""}: ${loaded.reason}`,
		);
		process.exit(2);
	}

	for (const rule of loaded.rules) {
		const dirExists = existsSync(rule.resolved);
		const warning = dirExists ? "" : "  (warning: directory does not exist)";
		console.log(`  ${rule.line}: ${rule.raw}${warning}`);
	}

	const countWarning = rulesCountWarning(loaded.rules.length);
	if (countWarning) {
		console.log("");
		console.log(`  ${countWarning}`);
	}
}

async function exclude() {
	const subcommand = args[1];
	switch (subcommand) {
		case "check":
			await excludeCheck(args[2] && !args[2].startsWith("--") ? args[2] : undefined);
			break;
		case "add":
			excludeAdd(args[2]);
			break;
		case "list":
			excludeList();
			break;
		default:
			console.error(`Unknown exclude subcommand: ${subcommand ?? "(none)"}`);
			printExcludeHelp();
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
	case "exclude":
		await exclude();
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
