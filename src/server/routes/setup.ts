import { Hono } from "hono";
import { config } from "../config.js";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../installers.js";

const setup = new Hono();

// F198: 0.0.0.0 is the "any interface" bind address, not a routable host —
// treated as loopback so a PUBLIC_URL of http://0.0.0.0:<port> is rejected
// the same way http://localhost:<port> is (F172), instead of being handed
// out to a remote installer that can never reach it.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
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

function isLoopbackHostname(hostname: string) {
	return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * D19: base URL for the local installers (/setup.sh, /install-local.*), whose
 * hooks must hit this machine. Only a numeric Host port is used; the Host
 * hostname never is.
 */
export function resolveLocalHookBaseUrl(host: string | undefined): string {
	return `http://localhost:${parseHost(host).port ?? config.port}`;
}

type InstallerErrorCode = keyof typeof INSTALLER_ERROR_MESSAGES;

type PublicServerUrl =
	| { ok: true; url: string }
	| { ok: false; error: Exclude<InstallerErrorCode, "installer_unavailable"> };

/**
 * D19: the server URL a remote relay should talk to. It comes from PUBLIC_URL
 * only (its first entry when comma-separated), never from the Host hostname.
 * A request from this machine may use a localhost URL; anyone else needs a
 * PUBLIC_URL they can actually reach (F172).
 */
export function resolvePublicServerUrl(host: string | undefined): PublicServerUrl {
	const requester = parseHost(host);
	const fromThisMachine = isLoopbackHostname(requester.hostname);
	if (!config.publicUrlExplicit) {
		if (!fromThisMachine) return { ok: false, error: "public_url_unset" };
		// F174: the port the request came in on, the same rule as the local installers.
		return { ok: true, url: `http://localhost:${requester.port ?? config.port}` };
	}
	const url = (config.publicUrl.split(",")[0] ?? "").trim().replace(/\/+$/, "");
	if (!SAFE_SERVER_URL_RE.test(url)) return { ok: false, error: "public_url_invalid" };
	if (!fromThisMachine && isLoopbackHostname(new URL(url).hostname.toLowerCase())) {
		return { ok: false, error: "public_url_loopback" };
	}
	return { ok: true, url };
}

const SET_PUBLIC_URL =
	"Set PUBLIC_URL on the AgentPulse server so the relay installer knows its public address.";

const INSTALLER_ERROR_MESSAGES = {
	public_url_unset: SET_PUBLIC_URL,
	public_url_invalid: `PUBLIC_URL on the AgentPulse server isn't a plain http(s) URL, so the relay installer can't use it. ${SET_PUBLIC_URL}`,
	public_url_loopback: `PUBLIC_URL on the AgentPulse server is a localhost address, which other machines can't reach. ${SET_PUBLIC_URL}`,
	installer_unavailable:
		"The relay installer isn't available on this server right now. Check the server log.",
} as const;

export const INSTALLER_ERROR_CODES = Object.keys(INSTALLER_ERROR_MESSAGES) as InstallerErrorCode[];

/**
 * F166: a 503 body that's still valid shell, so `curl | bash` prints the
 * reason and fails instead of executing JSON. The message goes through a
 * quoted heredoc, so no character in it needs escaping.
 */
export function installerErrorBody(error: InstallerErrorCode): string {
	return [
		"#!/bin/sh",
		`# ${JSON.stringify({ error })}`,
		"cat >&2 <<'AGENTPULSE_ERROR'",
		`AgentPulse: ${INSTALLER_ERROR_MESSAGES[error]}`,
		"AGENTPULSE_ERROR",
		"exit 1",
		"",
	].join("\n");
}

// F192: every installer response embeds the requester's Host (port for the
// local scripts, F174; PUBLIC_URL eligibility for the relay one, F172), so a
// shared/CDN cache keying only on the URL would serve one requester's body to
// another. no-store rules out caching it at all; Vary: Host documents why for
// any cache that does inspect it.
const INSTALLER_RESPONSE_HEADERS = { "Cache-Control": "no-store", Vary: "Host" } as const;

function installerError(error: InstallerErrorCode) {
	return new Response(installerErrorBody(error), {
		status: 503,
		headers: { "Content-Type": "text/plain; charset=utf-8", ...INSTALLER_RESPONSE_HEADERS },
	});
}

function scriptResponse(script: string, filename: string) {
	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": `inline; filename=${filename}`,
			...INSTALLER_RESPONSE_HEADERS,
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

// GET /install-local.sh - Serve the local Bun+SQLite installer
// Usage: curl -sSL http://localhost:3000/install-local.sh | bash
setup.get("/install-local.sh", (c) => {
	const url = resolveLocalHookBaseUrl(c.req.header("Host"));
	return scriptResponse(
		INSTALLER_SOURCES.installLocalSh.replace('PUBLIC_URL=""', () => `PUBLIC_URL="${url}"`),
		"install-local.sh",
	);
});

// GET /install-local.ps1 - Serve the local Bun+SQLite installer for Windows
// Usage: irm http://localhost:3000/install-local.ps1 | iex
setup.get("/install-local.ps1", (c) => {
	const url = resolveLocalHookBaseUrl(c.req.header("Host"));
	return scriptResponse(
		INSTALLER_SOURCES.installLocalPs1.replace(
			'[string]$PublicUrl = ""',
			() => `[string]$PublicUrl = "${url}"`,
		),
		"install-local.ps1",
	);
});

// GET /setup-relay.sh - One-command relay setup for machines whose agents
// report to a remote AgentPulse server.
// Usage: curl -sSL https://your-server.com/setup-relay.sh | bash
setup.get("/setup-relay.sh", (c) => {
	const server = resolvePublicServerUrl(c.req.header("Host"));
	if (!server.ok) return installerError(server.error);
	const built = buildRelayInstaller(INSTALLER_SOURCES, server.url);
	if (!built.ok) {
		console.error(`[setup] relay installer unavailable: ${built.reason}`);
		return installerError("installer_unavailable");
	}
	return scriptResponse(built.script, "setup-relay.sh");
});

export { setup };
