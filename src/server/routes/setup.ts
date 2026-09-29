import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { config } from "../config.js";

const setup = new Hono();

/** Overrides where the served installers are read from (tests, repackaging). */
export const SCRIPTS_DIR_ENV = "AGENTPULSE_INSTALLER_SCRIPTS_DIR";

function scriptsDir() {
	return process.env[SCRIPTS_DIR_ENV] || join(import.meta.dir, "../../../scripts");
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PORT_RE = /^[0-9]{1,5}$/;
// Spliced into a double-quoted shell string, so nothing that expands there.
const SAFE_SERVER_URL_RE =
	/^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/;

/** Splits a Host header into hostname and port; the port is null unless numeric. */
function parseHost(host: string | undefined): { hostname: string; port: string | null } {
	if (!host) return { hostname: "", port: null };
	const bracketed = /^(\[[^\]]*\])(?::(.*))?$/.exec(host);
	const [hostname, rawPort] = bracketed
		? [bracketed[1], bracketed[2]]
		: host.indexOf(":") === host.lastIndexOf(":")
			? (host.split(":") as [string, string | undefined])
			: [host, undefined];
	const port =
		rawPort !== undefined && PORT_RE.test(rawPort) && Number(rawPort) <= 65535 ? rawPort : null;
	return { hostname: hostname.toLowerCase(), port };
}

/**
 * D19: base URL for the local installers (/setup.sh, /install-local.*), whose
 * hooks must hit this machine. Only a numeric Host port is used; the Host
 * hostname never is.
 */
export function resolveLocalHookBaseUrl(host: string | undefined): string {
	return `http://localhost:${parseHost(host).port ?? config.port}`;
}

type PublicServerUrl =
	| { ok: true; url: string }
	| { ok: false; error: "public_url_unset" | "public_url_invalid" };

/**
 * D19: the server URL a remote relay should talk to. It comes from PUBLIC_URL
 * only (its first entry when comma-separated), never from Host. Without an
 * explicit PUBLIC_URL, only a loopback request gets an answer.
 */
export function resolvePublicServerUrl(host: string | undefined): PublicServerUrl {
	if (!config.publicUrlExplicit) {
		if (!LOOPBACK_HOSTNAMES.has(parseHost(host).hostname)) {
			return { ok: false, error: "public_url_unset" };
		}
		return { ok: true, url: `http://localhost:${config.port}` };
	}
	const url = (config.publicUrl.split(",")[0] ?? "").trim().replace(/\/+$/, "");
	if (!SAFE_SERVER_URL_RE.test(url)) return { ok: false, error: "public_url_invalid" };
	return { ok: true, url };
}

const INSTALLER_ERROR_MESSAGES = {
	public_url_unset:
		"Set PUBLIC_URL on the AgentPulse server so the relay installer knows its public address.",
	public_url_invalid:
		"PUBLIC_URL on the AgentPulse server isn't a plain http(s) URL, so the relay installer can't use it.",
	installer_unavailable:
		"The relay installer isn't available on this server right now. Check the server log.",
} as const;

/**
 * A 503 that's still safe to pipe into bash: `curl | bash` prints the reason
 * and fails instead of executing a JSON body.
 */
function installerError(error: keyof typeof INSTALLER_ERROR_MESSAGES) {
	const body = [
		"#!/bin/sh",
		`# ${JSON.stringify({ error })}`,
		`echo 'AgentPulse: ${INSTALLER_ERROR_MESSAGES[error]}' >&2`,
		"exit 1",
		"",
	].join("\n");
	return new Response(body, {
		status: 503,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function scriptResponse(script: string, filename: string) {
	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": `inline; filename=${filename}`,
		},
	});
}

// GET /setup.sh - Serve a self-contained install script
// Usage: curl -sSL https://your-server.com/setup.sh | bash
// Or:    curl -sSL https://your-server.com/setup.sh | bash -s -- --key ap_xxx
setup.get("/setup.sh", (c) => {
	const defaultLocalUrl = resolveLocalHookBaseUrl(c.req.header("Host"));

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────
#  AgentPulse - One-Command Hook Setup
#  Configures Claude Code + Codex CLI to report to AgentPulse
# ───────────────────────────────────────────────────

# Hooks MUST point to localhost -- Claude Code and Codex block
# HTTP hooks to remote/private IPs as a security measure.
HOOK_URL="${defaultLocalUrl}"
API_KEY=""

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --url) HOOK_URL="\$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "  AgentPulse Setup"
echo "  ────────────────"
echo "  Hooks will point to: \$HOOK_URL"
echo ""

# ── Claude Code ──

CLAUDE_DIR="\$HOME/.claude"
CLAUDE_SETTINGS="\$CLAUDE_DIR/settings.json"
mkdir -p "\$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

HOOKS_JSON="{"
for i in "\${!EVENTS[@]}"; do
  EVENT="\${EVENTS[\$i]}"
  [[ \$i -gt 0 ]] && HOOKS_JSON+=","
  if [[ -n "\$API_KEY" ]]; then
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  else
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"allowedEnvVars\\":[\\"AGENTPULSE_API_KEY\\"],\\"headers\\":{\\"Authorization\\":\\"Bearer \\\\\$AGENTPULSE_API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  fi
done
HOOKS_JSON+="}"

if [[ -f "\$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "\$HOOKS_JSON" '.hooks = (.hooks // {}) * \$hooks' "\$CLAUDE_SETTINGS" > "\$CLAUDE_SETTINGS.tmp"
  mv "\$CLAUDE_SETTINGS.tmp" "\$CLAUDE_SETTINGS"
elif [[ -f "\$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
with open('\$CLAUDE_SETTINGS') as f: s = json.load(f)
h = json.loads('''\$HOOKS_JSON''')
s.setdefault('hooks', {}).update(h)
with open('\$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo '{"hooks":'\$HOOKS_JSON'}' > "\$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks configured"

# ── Codex CLI ──

CODEX_DIR="\$HOME/.codex"
mkdir -p "\$CODEX_DIR"

CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop" "SubagentStart" "SubagentStop" "PermissionRequest" "PreCompact" "PostCompact")
CODEX_HOOKS="["
for i in "\${!CODEX_EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && CODEX_HOOKS+=","
  if [[ -n "\$API_KEY" ]]; then
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"codex_cli\\"}}"
  else
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"codex_cli\\"}}"
  fi
done
CODEX_HOOKS+="]"

echo '{"hooks":'\$CODEX_HOOKS'}' > "\$CODEX_DIR/hooks.json"
# Hooks are stable and enabled by default since codex-cli 0.124.0; codex_hooks
# is a recognized legacy alias for the \`hooks\` feature, written for
# compatibility with older codex-cli installs that still gate on it.
if [[ -f "\$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "\$CODEX_DIR/config.toml" || echo -e "\\n[features]\\ncodex_hooks = true" >> "\$CODEX_DIR/config.toml"
else
  echo -e "[features]\\ncodex_hooks = true" > "\$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks configured"

# ── Env vars ──

if [[ -n "\$API_KEY" ]]; then
  PROFILE="\$HOME/.zshrc"
  [[ "\$(basename "\$SHELL")" == "bash" ]] && PROFILE="\$HOME/.bashrc"
  if ! grep -q "AGENTPULSE_API_KEY" "\$PROFILE" 2>/dev/null; then
    echo "" >> "\$PROFILE"
    echo "# AgentPulse" >> "\$PROFILE"
    echo "export AGENTPULSE_API_KEY=\\"\$API_KEY\\"" >> "\$PROFILE"
    echo "export AGENTPULSE_URL=\\"\$HOOK_URL\\"" >> "\$PROFILE"
    echo "  ✓ Added env vars to \$PROFILE"
  fi
fi

# ── Verify ──

if curl -sf "\$HOOK_URL/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Server reachable"
else
  echo "  ! Server not reachable at \$HOOK_URL"
fi

echo ""
echo "  Done! Open a new terminal and start a Claude Code or Codex session."
echo ""
`;

	return scriptResponse(script, "setup.sh");
});

/**
 * Reads a local installer and fills in its localhost default. Read per
 * request; a missing file is a 503, never a throw (F16).
 */
async function serveLocalInstaller(
	host: string | undefined,
	filename: string,
	placeholder: string,
	filled: (url: string) => string,
) {
	let script: string;
	try {
		script = await readFile(join(scriptsDir(), filename), "utf-8");
	} catch (err) {
		console.error(`[setup] can't read ${filename}: ${(err as Error).message}`);
		return installerError("installer_unavailable");
	}
	return scriptResponse(
		script.replace(placeholder, filled(resolveLocalHookBaseUrl(host))),
		filename,
	);
}

// GET /install-local.sh - Serve the local Bun+SQLite installer
// Usage: curl -sSL http://localhost:3000/install-local.sh | bash
setup.get("/install-local.sh", (c) =>
	serveLocalInstaller(
		c.req.header("Host"),
		"install-local.sh",
		'PUBLIC_URL=""',
		(url) => `PUBLIC_URL="${url}"`,
	),
);

// GET /install-local.ps1 - Serve the local Bun+SQLite installer for Windows
// Usage: irm http://localhost:3000/install-local.ps1 | iex
setup.get("/install-local.ps1", (c) =>
	serveLocalInstaller(
		c.req.header("Host"),
		"install-local.ps1",
		'[string]$PublicUrl = ""',
		(url) => `[string]$PublicUrl = "${url}"`,
	),
);

// The relay installer is scripts/setup-relay.sh with the relay and statusline
// spliced in at these markers, so what it installs is byte-identical to the
// files /api/v1/health checksums (r7). Otherwise the relay's drift check would
// report "outdated" forever.
const RELAY_EMBEDS = [
	{
		marker: "# @@AGENTPULSE_RELAY_TS@@",
		file: "relay.ts",
		terminator: "AGENTPULSE_RELAY_TS_EOF",
	},
	{
		marker: "# @@AGENTPULSE_STATUSLINE_SH@@",
		file: "statusline.sh",
		terminator: "AGENTPULSE_STATUSLINE_SH_EOF",
	},
] as const;
const REMOTE_URL_PLACEHOLDER = 'REMOTE_URL_DEFAULT=""';

type BuiltInstaller = { ok: true; script: string } | { ok: false; reason: string };

async function buildRelayInstaller(remoteUrl: string): Promise<BuiltInstaller> {
	const dir = scriptsDir();
	let script: string;
	const sources: string[] = [];
	try {
		script = await readFile(join(dir, "setup-relay.sh"), "utf-8");
		for (const embed of RELAY_EMBEDS) sources.push(await readFile(join(dir, embed.file), "utf-8"));
	} catch (err) {
		return { ok: false, reason: (err as Error).message };
	}
	if (script.split(REMOTE_URL_PLACEHOLDER).length !== 2) {
		return { ok: false, reason: "setup-relay.sh lacks exactly one REMOTE_URL_DEFAULT placeholder" };
	}
	script = script.replace(REMOTE_URL_PLACEHOLDER, `REMOTE_URL_DEFAULT="${remoteUrl}"`);
	for (const [i, embed] of RELAY_EMBEDS.entries()) {
		const lines = script.split("\n");
		const at = lines.indexOf(embed.marker);
		if (at === -1 || lines.lastIndexOf(embed.marker) !== at) {
			return { ok: false, reason: `setup-relay.sh lacks exactly one ${embed.marker} line` };
		}
		const body = sources[i].replace(/\n+$/, "");
		if (body.includes("@@AGENTPULSE_")) {
			return { ok: false, reason: `${embed.file} contains an installer marker` };
		}
		if (body.split("\n").includes(embed.terminator)) {
			return { ok: false, reason: `${embed.file} contains the line ${embed.terminator}` };
		}
		lines[at] =
			`cat > "$SRC_DIR/${embed.file}" << '${embed.terminator}'\n${body}\n${embed.terminator}`;
		script = lines.join("\n");
	}
	return { ok: true, script };
}

// GET /setup-relay.sh - One-command relay setup for machines whose agents
// report to a remote AgentPulse server.
// Usage: curl -sSL https://your-server.com/setup-relay.sh | bash -s -- --key ap_xxx
setup.get("/setup-relay.sh", async (c) => {
	const server = resolvePublicServerUrl(c.req.header("Host"));
	if (!server.ok) return installerError(server.error);
	const built = await buildRelayInstaller(server.url);
	if (!built.ok) {
		console.error(`[setup] relay installer unavailable: ${built.reason}`);
		return installerError("installer_unavailable");
	}
	return scriptResponse(built.script, "setup-relay.sh");
});

export { setup };
