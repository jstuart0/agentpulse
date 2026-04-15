#!/usr/bin/env bash
set -euo pipefail

# AgentPulse Hook Setup Script
# Usage: bash setup-hooks.sh --url https://agentpulse.xmojo.net --key ap_xxxxx
# Or:    curl -sSL https://agentpulse.xmojo.net/setup.sh | bash -s -- --url https://agentpulse.xmojo.net --key ap_xxxxx

AGENTPULSE_URL=""
AGENTPULSE_KEY=""
AGENT_TYPE="claude_code"
SCOPE="global"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) AGENTPULSE_URL="$2"; shift 2 ;;
    --key) AGENTPULSE_KEY="$2"; shift 2 ;;
    --agent) AGENT_TYPE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    -h|--help)
      echo "AgentPulse Hook Setup"
      echo ""
      echo "Usage: setup-hooks.sh --url <server_url> --key <api_key>"
      echo ""
      echo "Options:"
      echo "  --url    AgentPulse server URL (e.g. https://agentpulse.xmojo.net)"
      echo "  --key    API key (starts with ap_)"
      echo "  --agent  Agent type: claude_code (default) or codex_cli"
      echo "  --scope  Scope: global (default) or project"
      echo "  -h       Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$AGENTPULSE_URL" ]]; then
  echo "Error: --url is required"
  exit 1
fi

if [[ -z "$AGENTPULSE_KEY" ]]; then
  echo "Error: --key is required"
  exit 1
fi

# Verify connectivity
echo "Checking AgentPulse server..."
if ! curl -sf "${AGENTPULSE_URL}/api/v1/health" > /dev/null 2>&1; then
  echo "Warning: Cannot reach ${AGENTPULSE_URL}/api/v1/health"
  echo "Continuing anyway -- make sure the server is running."
fi

# ─── Claude Code Setup ───────────────────────────────────────────────

if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  if [[ "$SCOPE" == "global" ]]; then
    SETTINGS_FILE="$HOME/.claude/settings.json"
  else
    SETTINGS_FILE=".claude/settings.json"
    mkdir -p .claude
  fi

  echo "Configuring Claude Code hooks..."

  # Events to hook
  EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit")

  # Build the hooks JSON object
  HOOKS_JSON="{"
  for i in "${!EVENTS[@]}"; do
    EVENT="${EVENTS[$i]}"
    if [[ $i -gt 0 ]]; then
      HOOKS_JSON+=","
    fi
    HOOKS_JSON+="\"${EVENT}\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_API_KEY\"],\"headers\":{\"Authorization\":\"Bearer \$AGENTPULSE_API_KEY\",\"X-Agent-Type\":\"claude_code\"}}]"
  done
  HOOKS_JSON+="}"

  if [[ -f "$SETTINGS_FILE" ]]; then
    # Merge hooks into existing settings using jq if available
    if command -v jq &> /dev/null; then
      echo "Merging hooks into existing $SETTINGS_FILE..."
      EXISTING=$(cat "$SETTINGS_FILE")
      echo "$EXISTING" | jq --argjson hooks "$HOOKS_JSON" '.hooks = (.hooks // {}) * $hooks' > "${SETTINGS_FILE}.tmp"
      mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
    else
      echo "Warning: jq not found. Cannot safely merge into existing settings."
      echo "Please manually add the following hooks to $SETTINGS_FILE:"
      echo ""
      echo "\"hooks\": $HOOKS_JSON"
      echo ""
    fi
  else
    # Create new settings file
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    echo "{\"hooks\":$HOOKS_JSON}" | python3 -m json.tool > "$SETTINGS_FILE" 2>/dev/null || echo "{\"hooks\":$HOOKS_JSON}" > "$SETTINGS_FILE"
  fi

  echo "Claude Code hooks configured in $SETTINGS_FILE"

# ─── Codex CLI Setup ─────────────────────────────────────────────────

elif [[ "$AGENT_TYPE" == "codex_cli" ]]; then
  HOOKS_FILE="$HOME/.codex/hooks.json"
  EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop")

  echo "Configuring Codex CLI hooks..."

  HOOKS_ARRAY="["
  for i in "${!EVENTS[@]}"; do
    EVENT="${EVENTS[$i]}"
    if [[ $i -gt 0 ]]; then
      HOOKS_ARRAY+=","
    fi
    HOOKS_ARRAY+="{\"event\":\"${EVENT}\",\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"headers\":{\"Authorization\":\"Bearer ${AGENTPULSE_KEY}\",\"X-Agent-Type\":\"codex_cli\"}}"
  done
  HOOKS_ARRAY+="]"

  mkdir -p "$HOME/.codex"
  echo "{\"hooks\":$HOOKS_ARRAY}" | python3 -m json.tool > "$HOOKS_FILE" 2>/dev/null || echo "{\"hooks\":$HOOKS_ARRAY}" > "$HOOKS_FILE"

  # Enable hooks feature flag in config.toml
  CONFIG_TOML="$HOME/.codex/config.toml"
  if [[ -f "$CONFIG_TOML" ]]; then
    if ! grep -q "codex_hooks" "$CONFIG_TOML"; then
      echo "" >> "$CONFIG_TOML"
      echo "[features]" >> "$CONFIG_TOML"
      echo "codex_hooks = true" >> "$CONFIG_TOML"
    fi
  else
    mkdir -p "$HOME/.codex"
    echo '[features]' > "$CONFIG_TOML"
    echo 'codex_hooks = true' >> "$CONFIG_TOML"
  fi

  echo "Codex CLI hooks configured in $HOOKS_FILE"
  echo "Hooks feature enabled in $CONFIG_TOML"

else
  echo "Error: Unknown agent type '$AGENT_TYPE'. Use 'claude_code' or 'codex_cli'."
  exit 1
fi

# ─── Environment Variable ────────────────────────────────────────────

echo ""
echo "Setting AGENTPULSE_API_KEY environment variable..."

# Detect shell
SHELL_NAME="$(basename "$SHELL")"
if [[ "$SHELL_NAME" == "zsh" ]]; then
  PROFILE="$HOME/.zshrc"
elif [[ "$SHELL_NAME" == "bash" ]]; then
  PROFILE="$HOME/.bashrc"
else
  PROFILE="$HOME/.profile"
fi

# Add env var if not already present
if ! grep -q "AGENTPULSE_API_KEY" "$PROFILE" 2>/dev/null; then
  echo "" >> "$PROFILE"
  echo "# AgentPulse API key for hook authentication" >> "$PROFILE"
  echo "export AGENTPULSE_API_KEY=\"${AGENTPULSE_KEY}\"" >> "$PROFILE"
  echo "Added AGENTPULSE_API_KEY to $PROFILE"
else
  echo "AGENTPULSE_API_KEY already set in $PROFILE"
fi

# Also set AGENTPULSE_URL
if ! grep -q "AGENTPULSE_URL" "$PROFILE" 2>/dev/null; then
  echo "export AGENTPULSE_URL=\"${AGENTPULSE_URL}\"" >> "$PROFILE"
  echo "Added AGENTPULSE_URL to $PROFILE"
fi

# ─── Verify ──────────────────────────────────────────────────────────

echo ""
echo "Sending test event..."
TEST_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AGENTPULSE_URL}/api/v1/hooks" \
  -H "Authorization: Bearer ${AGENTPULSE_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Type: ${AGENT_TYPE}" \
  -d "{\"session_id\":\"setup-test-$(date +%s)\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"$(pwd)\",\"source\":\"setup-script\"}" 2>/dev/null || echo "000")

if [[ "$TEST_RESULT" == "200" ]]; then
  echo "Test event sent successfully!"
else
  echo "Warning: Test event returned HTTP $TEST_RESULT (expected 200)"
fi

echo ""
echo "Setup complete! Restart your shell or run:"
echo "  source $PROFILE"
echo ""
echo "Then start a new ${AGENT_TYPE} session to see it in AgentPulse."
