import { Hono } from "hono";
import { config } from "../config.js";

const setup = new Hono();

// GET /setup.sh - Serve a self-contained install script
// Usage: curl -sSL https://agentpulse.xmojo.net/setup.sh | bash
// Or:    curl -sSL https://agentpulse.xmojo.net/setup.sh | bash -s -- --key ap_xxx
setup.get("/setup.sh", (c) => {
	const serverUrl = config.publicUrl || `http://localhost:${config.port}`;

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────
#  AgentPulse - One-Command Hook Setup
#  Configures Claude Code + Codex CLI to report to AgentPulse
# ───────────────────────────────────────────────────

SERVER_URL="${serverUrl}"
API_KEY=""

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --url) SERVER_URL="\$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "  AgentPulse Setup"
echo "  ────────────────"
echo "  Server: \$SERVER_URL"
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
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${SERVER_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  else
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${SERVER_URL}/api/v1/hooks\\",\\"async\\":true,\\"allowedEnvVars\\":[\\"AGENTPULSE_API_KEY\\"],\\"headers\\":{\\"Authorization\\":\\"Bearer \\\\\$AGENTPULSE_API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
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
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${SERVER_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"codex_cli\\"}}"
  else
    CODEX_HOOKS+="{\\"event\\":\\"\${CODEX_EVENTS[\$i]}\\",\\"type\\":\\"http\\",\\"url\\":\\"\${SERVER_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"X-Agent-Type\\":\\"codex_cli\\"}}"
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
    echo "export AGENTPULSE_URL=\\"\$SERVER_URL\\"" >> "\$PROFILE"
    echo "  ✓ Added env vars to \$PROFILE"
  fi
fi

# ── Verify ──

if curl -sf "\$SERVER_URL/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Server reachable"
else
  echo "  ! Server not reachable at \$SERVER_URL"
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

export { setup };
