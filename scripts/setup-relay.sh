#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────────
#  AgentPulse Relay Setup
#
#  For users who run AgentPulse on a remote server (k8s, VPS, etc.)
#  but need hooks to go through localhost (Claude Code requirement).
#
#  This script:
#  1. Installs the relay script to ~/.agentpulse/relay.ts
#  2. Creates a macOS LaunchAgent to auto-start on login
#  3. Configures Claude Code + Codex hooks to point at localhost
#  4. Starts the relay immediately
#
#  Usage:
#    bash setup-relay.sh --url https://agentpulse.example.com --key ap_xxx
#    bash setup-relay.sh --url https://agentpulse.example.com --key ap_xxx --port 4000
# ───────────────────────────────────────────────────────

REMOTE_URL=""
API_KEY=""
PORT=4000
BUN_PATH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --url) REMOTE_URL="$2"; shift 2 ;;
    --key) API_KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: setup-relay.sh --url <remote_url> --key <api_key> [--port 4000]"
      exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ -z "$REMOTE_URL" ]]; then
  echo "Error: --url is required (your remote AgentPulse server)"
  echo "Example: bash setup-relay.sh --url https://your-server.com --key ap_xxx"
  exit 1
fi

REMOTE_URL="${REMOTE_URL%/}"

echo ""
echo "  AgentPulse Relay Setup"
echo "  ──────────────────────"
echo "  Remote:  $REMOTE_URL"
echo "  Local:   http://localhost:$PORT"
echo ""

# ── Find Bun ──

if command -v bun &>/dev/null; then
  BUN_PATH="$(which bun)"
elif [[ -f "$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="$HOME/.bun/bin/bun"
else
  echo "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  BUN_PATH="$HOME/.bun/bin/bun"
fi
echo "  ✓ Bun: $BUN_PATH"

# ── Install relay script ──

RELAY_DIR="$HOME/.agentpulse"
mkdir -p "$RELAY_DIR"

cat > "$RELAY_DIR/relay.ts" << 'RELAY_EOF'
#!/usr/bin/env bun
const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i+1]) port = Number(args[++i]);
  else if (args[i] === "--key" && args[i+1]) apiKey = args[++i];
  else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\/$/, "");
}
if (!remoteUrl) { console.error("Usage: relay.ts <url> [--port N] [--key K]"); process.exit(1); }

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/health") {
      return Response.json({ status: "ok", relay: true, remote: remoteUrl });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        const headers = new Headers();
        headers.set("Content-Type", req.headers.get("Content-Type") || "application/json");
        if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
        const agentType = req.headers.get("X-Agent-Type");
        if (agentType) headers.set("X-Agent-Type", agentType);
        const body = req.method !== "GET" ? await req.text() : undefined;
        const res = await fetch(`${remoteUrl}${url.pathname}${url.search}`, {
          method: req.method, headers, body,
          signal: AbortSignal.timeout(10000),
        });
        const rb = await res.text();
        return new Response(rb, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
        });
      } catch {
        if (url.pathname.includes("/hooks")) return Response.json({ ok: true, relayed: false });
        return Response.json({ error: "Relay failed" }, { status: 502 });
      }
    }
    return Response.redirect(remoteUrl + url.pathname, 302);
  },
});
console.log(`AgentPulse Relay: localhost:${port} -> ${remoteUrl}`);
RELAY_EOF

# Save config
cat > "$RELAY_DIR/config.json" << EOF
{
  "remote_url": "$REMOTE_URL",
  "api_key": "${API_KEY}",
  "port": $PORT
}
EOF

echo "  ✓ Relay installed to $RELAY_DIR/relay.ts"

# ── macOS LaunchAgent ──

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/dev.agentpulse.relay.plist"
LOG_DIR="$RELAY_DIR/logs"
mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>${RELAY_DIR}/relay.ts</string>
    <string>${REMOTE_URL}</string>
    <string>--port</string>
    <string>${PORT}</string>
$(if [[ -n "$API_KEY" ]]; then echo "    <string>--key</string>"; echo "    <string>${API_KEY}</string>"; fi)
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/relay.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/relay.err</string>
  <key>WorkingDirectory</key>
  <string>${RELAY_DIR}</string>
</dict>
</plist>
EOF

# Stop any existing relay
launchctl unload "$PLIST_FILE" 2>/dev/null || true

# Start the relay
launchctl load "$PLIST_FILE"
echo "  ✓ LaunchAgent installed (auto-starts on login)"

# Wait for relay to start
sleep 2
if curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Relay running on localhost:$PORT"
else
  echo "  ! Relay may not have started yet. Check: $LOG_DIR/relay.err"
fi

# ── Configure hooks ──

echo ""
echo "  Configuring agent hooks..."

# Claude Code
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")

HOOKS_JSON="{"
for i in "${!EVENTS[@]}"; do
  EVENT="${EVENTS[$i]}"
  [[ $i -gt 0 ]] && HOOKS_JSON+=","
  HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"http://localhost:${PORT}/api/v1/hooks\",\"async\":true,\"headers\":{\"X-Agent-Type\":\"claude_code\"}}]}]"
done
HOOKS_JSON+="}"

if [[ -f "$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "$HOOKS_JSON" '.hooks = (.hooks // {}) * $hooks' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"
  mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
elif [[ -f "$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json
with open('$CLAUDE_SETTINGS') as f: s = json.load(f)
h = json.loads('''$HOOKS_JSON''')
s.setdefault('hooks', {}).update(h)
with open('$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo "{\"hooks\":$HOOKS_JSON}" > "$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks → localhost:$PORT"

# Codex CLI
CODEX_DIR="$HOME/.codex"
mkdir -p "$CODEX_DIR"
CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")
CODEX_HOOKS="["
for i in "${!CODEX_EVENTS[@]}"; do
  [[ $i -gt 0 ]] && CODEX_HOOKS+=","
  CODEX_HOOKS+="{\"event\":\"${CODEX_EVENTS[$i]}\",\"type\":\"http\",\"url\":\"http://localhost:${PORT}/api/v1/hooks\",\"async\":true,\"headers\":{\"X-Agent-Type\":\"codex_cli\"}}"
done
CODEX_HOOKS+="]"
echo "{\"hooks\":$CODEX_HOOKS}" > "$CODEX_DIR/hooks.json"
if [[ -f "$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "$CODEX_DIR/config.toml" || echo -e "\n[features]\ncodex_hooks = true" >> "$CODEX_DIR/config.toml"
else
  echo -e "[features]\ncodex_hooks = true" > "$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks → localhost:$PORT"

# ── Done ──

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  Relay setup complete!                           ║"
echo "  ╠══════════════════════════════════════════════════╣"
echo "  ║  Relay:     http://localhost:$PORT                ║"
echo "  ║  Remote:    $REMOTE_URL"
echo "  ║  Dashboard: $REMOTE_URL"
echo "  ║  Auto-start: yes (LaunchAgent)                   ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  Open a new Claude Code or Codex session to start"
echo "  seeing events in your dashboard."
echo ""
echo "  Manage:"
echo "    Stop:    launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
echo "    Start:   launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
echo "    Logs:    tail -f ~/.agentpulse/logs/relay.log"
echo "    Config:  cat ~/.agentpulse/config.json"
echo ""
