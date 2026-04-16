import { Hono } from "hono";
import { config } from "../config.js";

const setup = new Hono();

// GET /setup.sh - Serve a self-contained install script
// Usage: curl -sSL https://agentpulse.xmojo.net/setup.sh | bash
// Or:    curl -sSL https://agentpulse.xmojo.net/setup.sh | bash -s -- --key ap_xxx
setup.get("/setup.sh", (c) => {
	// Detect the port from the request URL so hooks always point to localhost
	const requestHost = c.req.header("Host") || `localhost:${config.port}`;
	const requestPort = requestHost.includes(":") ? requestHost.split(":")[1] : config.port.toString();
	const defaultLocalUrl = `http://localhost:${requestPort}`;

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

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")

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

CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")
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

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=setup.sh",
		},
	});
});

// GET /setup-relay.sh - Self-contained relay setup for remote server users
// Usage: curl -sSL https://agentpulse.xmojo.net/setup-relay.sh | bash -s -- --key ap_xxx
setup.get("/setup-relay.sh", (c) => {
	const serverUrl = config.publicUrl || `https://${c.req.header("Host")}`;

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────────
#  AgentPulse Relay Setup (one command, no repo needed)
#
#  Installs a tiny relay on localhost that forwards hook events
#  to your remote AgentPulse server. Includes a LaunchAgent
#  so it auto-starts on login and restarts if it crashes.
#
#  Claude Code blocks hooks to remote IPs -- this relay solves that.
# ───────────────────────────────────────────────────────

REMOTE_URL="${serverUrl}"
API_KEY=""
PORT=4000

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --port) PORT="\$2"; shift 2 ;;
    --url) REMOTE_URL="\$2"; shift 2 ;;
    *) shift ;;
  esac
done

REMOTE_URL="\${REMOTE_URL%/}"

echo ""
echo "  AgentPulse Relay Setup"
echo "  ──────────────────────"
echo "  Remote:  \$REMOTE_URL"
echo "  Local:   http://localhost:\$PORT"
echo ""

# ── Install Bun if needed ──

BUN_PATH=""
if command -v bun &>/dev/null; then
  BUN_PATH="\$(which bun)"
elif [[ -f "\$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="\$HOME/.bun/bin/bun"
else
  echo "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  BUN_PATH="\$HOME/.bun/bin/bun"
fi
echo "  ✓ Bun: \$BUN_PATH"

# ── Install relay script ──

RELAY_DIR="\$HOME/.agentpulse"
mkdir -p "\$RELAY_DIR/logs"

cat > "\$RELAY_DIR/relay.ts" << 'INNER_EOF'
#!/usr/bin/env bun
import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i+1]) port = Number(args[++i]);
  else if (args[i] === "--key" && args[i+1]) apiKey = args[++i];
  else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\\/$/, "");
}
if (!remoteUrl) { console.error("Usage: relay.ts <url> [--port N] [--key K]"); process.exit(1); }
async function fe(p:string){try{await access(p,constants.F_OK);return true}catch{return false}}
Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/health") return Response.json({ status: "ok", relay: true, remote: remoteUrl });
    // Handle agents-md locally (remote can't read local files)
    if (url.pathname === "/api/v1/agents-md" && req.method === "GET") {
      const pp = url.searchParams.get("path");
      if (!pp || pp.includes("..")) return Response.json({ error: "Invalid" }, { status: 400 });
      const files = [];
      for (const n of ["CLAUDE.md","AGENTS.md"]) {
        const fp = join(pp, n); const ex = await fe(fp);
        let c = ""; if (ex) try { c = await readFile(fp, "utf-8") } catch {}
        files.push({ name: n, path: fp, content: c, exists: ex });
      }
      return Response.json({ files, projectPath: pp });
    }
    if (url.pathname === "/api/v1/agents-md" && req.method === "PUT") {
      const { path: fp, content: c } = await req.json() as any;
      if (!fp || fp.includes("..")) return Response.json({ error: "Invalid" }, { status: 400 });
      const bn = fp.split("/").pop() || "";
      if (!["CLAUDE.md","AGENTS.md"].includes(bn)) return Response.json({ error: "Not allowed" }, { status: 400 });
      try { await writeFile(fp, c, "utf-8"); return Response.json({ ok: true }); } catch(e) { return Response.json({ error: String(e) }, { status: 500 }); }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        const headers = new Headers();
        headers.set("Content-Type", req.headers.get("Content-Type") || "application/json");
        if (apiKey) headers.set("Authorization", "Bearer " + apiKey);
        const at = req.headers.get("X-Agent-Type"); if (at) headers.set("X-Agent-Type", at);
        const body = req.method !== "GET" ? await req.text() : undefined;
        const res = await fetch(remoteUrl + url.pathname + url.search, { method: req.method, headers, body, signal: AbortSignal.timeout(10000) });
        return new Response(await res.text(), { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" } });
      } catch {
        if (url.pathname.includes("/hooks")) return Response.json({ ok: true, relayed: false });
        return Response.json({ error: "Relay failed" }, { status: 502 });
      }
    }
    return Response.redirect(remoteUrl + url.pathname, 302);
  },
});
console.log("AgentPulse Relay: localhost:" + port + " -> " + remoteUrl);
INNER_EOF

echo "  ✓ Relay script installed"

# ── macOS LaunchAgent ──

if [[ "\$(uname)" == "Darwin" ]]; then
  PLIST="\$HOME/Library/LaunchAgents/dev.agentpulse.relay.plist"
  mkdir -p "\$HOME/Library/LaunchAgents"

  ARGS_XML="    <string>\${BUN_PATH}</string>
    <string>\${RELAY_DIR}/relay.ts</string>
    <string>\${REMOTE_URL}</string>
    <string>--port</string>
    <string>\${PORT}</string>"

  if [[ -n "\$API_KEY" ]]; then
    ARGS_XML="\${ARGS_XML}
    <string>--key</string>
    <string>\${API_KEY}</string>"
  fi

  cat > "\$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agentpulse.relay</string>
  <key>ProgramArguments</key><array>
\${ARGS_XML}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\${RELAY_DIR}/logs/relay.log</string>
  <key>StandardErrorPath</key><string>\${RELAY_DIR}/logs/relay.err</string>
  <key>WorkingDirectory</key><string>\${RELAY_DIR}</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "\$PLIST" 2>/dev/null || true
  launchctl load "\$PLIST"
  echo "  ✓ LaunchAgent installed (auto-starts on login)"
else
  # Linux: create a systemd user service
  SYSTEMD_DIR="\$HOME/.config/systemd/user"
  mkdir -p "\$SYSTEMD_DIR"

  KEY_ARG=""
  [[ -n "\$API_KEY" ]] && KEY_ARG="--key \$API_KEY"

  cat > "\$SYSTEMD_DIR/agentpulse-relay.service" << SYSTEMD_EOF
[Unit]
Description=AgentPulse Relay
After=network.target

[Service]
ExecStart=\${BUN_PATH} \${RELAY_DIR}/relay.ts \${REMOTE_URL} --port \${PORT} \${KEY_ARG}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SYSTEMD_EOF

  systemctl --user daemon-reload
  systemctl --user enable agentpulse-relay
  systemctl --user start agentpulse-relay
  echo "  ✓ systemd service installed (auto-starts on login)"
fi

# Wait for relay
sleep 2
if curl -sf "http://localhost:\${PORT}/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Relay running on localhost:\$PORT"
else
  echo "  ! Relay may still be starting. Check logs: tail ~/.agentpulse/logs/relay.err"
fi

# ── Configure hooks ──

echo ""

# Claude Code
CLAUDE_DIR="\$HOME/.claude"
CLAUDE_SETTINGS="\$CLAUDE_DIR/settings.json"
mkdir -p "\$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")
HOOKS_JSON="{"
for i in "\${!EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && HOOKS_JSON+=","
  HOOKS_JSON+="\\"\${EVENTS[\$i]}\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"http://localhost:\${PORT}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
done
HOOKS_JSON+="}"

if [[ -f "\$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "\$HOOKS_JSON" '.hooks = (.hooks // {}) * \$hooks' "\$CLAUDE_SETTINGS" > "\${CLAUDE_SETTINGS}.tmp"
  mv "\${CLAUDE_SETTINGS}.tmp" "\$CLAUDE_SETTINGS"
elif [[ -f "\$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json
with open('\$CLAUDE_SETTINGS') as f: s = json.load(f)
s.setdefault('hooks', {}).update(json.loads('''\$HOOKS_JSON'''))
with open('\$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo "{\\"hooks\\":\$HOOKS_JSON}" > "\$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks → localhost:\$PORT"

# Codex CLI
CODEX_DIR="\$HOME/.codex"
mkdir -p "\$CODEX_DIR"
CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")
CODEX_HOOKS="["
for i in "\${!CODEX_EVENTS[@]}"; do
  [[ \$i -gt 0 ]] && CODEX_HOOKS+=","
  CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"http://localhost:\${PORT}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"codex_cli\\"}}"
done
CODEX_HOOKS+="]"
echo "{\\"hooks\\":\$CODEX_HOOKS}" > "\$CODEX_DIR/hooks.json"
if [[ -f "\$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "\$CODEX_DIR/config.toml" || echo -e "\\n[features]\\ncodex_hooks = true" >> "\$CODEX_DIR/config.toml"
else
  echo -e "[features]\\ncodex_hooks = true" > "\$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks → localhost:\$PORT"

echo ""
echo "  Done! Open a new Claude Code or Codex session."
echo "  Dashboard: \$REMOTE_URL"
echo ""
echo "  Manage relay:"
if [[ "\$(uname)" == "Darwin" ]]; then
  echo "    Stop:  launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
  echo "    Start: launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
else
  echo "    Stop:  systemctl --user stop agentpulse-relay"
  echo "    Start: systemctl --user start agentpulse-relay"
fi
echo "    Logs:  tail -f ~/.agentpulse/logs/relay.log"
echo ""
`;

	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline; filename=setup-relay.sh",
		},
	});
});

export { setup };
