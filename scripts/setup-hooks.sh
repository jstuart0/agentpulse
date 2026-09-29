#!/usr/bin/env bash
set -euo pipefail

# AgentPulse Hook Setup Script
# Usage: bash setup-hooks.sh --url https://your-server.com --key ap_xxxxx
# Or:    curl -sSL https://your-server.com/setup.sh | bash -s -- --url https://your-server.com --key ap_xxxxx
#
# F234: --key is briefly visible in `ps` during that one-time install.
# Prefer the env-var form instead:
#   AGENTPULSE_KEY=ap_xxxxx curl -sSL https://your-server.com/setup.sh | bash -s -- --url https://your-server.com

AGENTPULSE_URL=""
# F234 (Low): --key is briefly visible in `ps` during a curl|bash install —
# seed from $AGENTPULSE_KEY (if exported) so `AGENTPULSE_KEY=ap_xxx bash` is
# a viable alternative; an explicit --key below still overrides it.
AGENTPULSE_KEY="${AGENTPULSE_KEY:-}"
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
      echo "  --url    AgentPulse server URL (e.g. https://your-server.com)"
      echo "  --key    API key (starts with ap_). Prefer \$AGENTPULSE_KEY instead:"
      echo "           --key is briefly visible in \`ps\` during a curl|bash install."
      echo "  --agent  Agent type: claude_code (default), codex_cli, or copilot_cli"
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

# >>> agentpulse-hook-cmd
# D13: shared hook-command generators. Byte-identical to buildBashHookCommand/
# buildCodexHooksFile in src/shared/hook-command.ts (verified by
# scripts/hook-command-parity.test.ts) — this exact block also appears
# verbatim in scripts/setup-relay.sh and the /setup.sh template served by
# src/server/routes/setup.ts. Do not hand-edit one copy without the others.
ap_hook_cmd() {
	# $1=base $2=direct(0/1) $3=agent $4=event
	local base="$1" direct="$2" agent="$3" event="$4"
	local marker="" call_with_header call_without_header body
	if [ "$agent" = "codex_cli" ]; then
		marker='sid=$(grep -o '\''"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"'\'' "$t" | head -n1); sid=${sid%\"}; sid=${sid##*\"}; case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ ${#sid} -le 128 ]; then mkdir -p "$HOME/.agentpulse/codex-native" 2>/dev/null; : > "$HOME/.agentpulse/codex-native/$sid" 2>/dev/null; fi ;; esac; '
	fi
	call_with_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' -H "@$f" --data-binary "@$t"'
	call_without_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' --data-binary "@$t"'
	if [ "$direct" = "1" ]; then
		body="$marker"'f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then '"$call_with_header"'; else '"$call_without_header"'; fi; rm -f "$t"'
	else
		body="$marker""$call_without_header"'; rm -f "$t"'
	fi
	printf '%s' 't=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( '"$body"' ) </dev/null >/dev/null 2>&1 & exit 0'
}

ap_codex_hooks_json() {
	# $1=base $2=direct(0/1)
	local base="$1" direct="$2"
	local CODEX_EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop" "Interrupt" "SubagentStart" "SubagentStop" "PermissionRequest" "PreCompact" "PostCompact")
	local event
	{
		for event in "${CODEX_EVENTS[@]}"; do
			printf '%s\0%s\0' "$event" "$(ap_hook_cmd "$base" "$direct" "codex_cli" "$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"hooks": [{"type": "command", "command": cmd, "async": False, "timeout": 1}]}]
sys.stdout.write(json.dumps({"hooks": hooks}, indent=2) + "\n")
'
}

ap_copilot_hooks_json() {
	# $1=base $2=direct(0/1)
	local base="$1" direct="$2"
	local COPILOT_EVENTS=("sessionStart" "sessionEnd" "userPromptSubmitted" "postToolUse" "postToolUseFailure" "agentStop" "subagentStart" "subagentStop" "preCompact" "errorOccurred")
	local event
	{
		for event in "${COPILOT_EVENTS[@]}"; do
			printf '%s\0%s\0' "$event" "$(ap_hook_cmd "$base" "$direct" "copilot_cli" "$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"type": "command", "bash": cmd, "timeoutSec": 5}]
sys.stdout.write(json.dumps({"version": 1, "hooks": hooks}, indent=2) + "\n")
'
}

# F232 (xander, Medium): writes stdin to $1 via a same-directory temp file +
# atomic rename, refusing a symlink at $1 or at $1's parent directory —
# never a plain `>` redirect or `cp`, both of which follow a symlink at the
# destination. Used for both a Codex/Copilot hooks.json write and its
# timestamped backup (same primitive, different path).
ap_write_no_follow() {
	local path="$1" dir tmp
	if [ -L "$path" ]; then
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	dir="$(dirname -- "$path")"
	if [ -L "$dir" ]; then
		echo "refusing to write into a symlinked directory: $dir" >&2
		return 1
	fi
	tmp="${path}.$$.tmp"
	if [ -e "$tmp" ] || [ -L "$tmp" ]; then
		echo "refusing: stale temp file present: $tmp" >&2
		return 1
	fi
	( umask 022 && cat > "$tmp" )
	chmod 0644 "$tmp"
	mv -f "$tmp" "$path"
}

# D13/F57: -H "@$f" needs curl >= 7.55 (silently sends no auth below that).
# Only direct-mode sh installers call this — relay mode sends no auth header.
ap_require_curl_755() {
	local ver major minor rest
	ver="$(curl --version 2>/dev/null | head -n1 | sed -nE 's/^curl ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
	if [ -z "$ver" ]; then
		echo "AgentPulse direct hooks need curl >= 7.55 (curl not found). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
	major="${ver%%.*}"
	rest="${ver#*.}"
	minor="${rest%%.*}"
	if [ "$major" -lt 7 ] || { [ "$major" -eq 7 ] && [ "$minor" -lt 55 ]; }; then
		echo "AgentPulse direct hooks need curl >= 7.55 (found ${ver}). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
}
# <<< agentpulse-hook-cmd

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
  EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

  # Build the hooks JSON object
  HOOKS_JSON="{"
  for i in "${!EVENTS[@]}"; do
    EVENT="${EVENTS[$i]}"
    if [[ $i -gt 0 ]]; then
      HOOKS_JSON+=","
    fi
    HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_API_KEY\"],\"headers\":{\"Authorization\":\"Bearer \$AGENTPULSE_API_KEY\",\"X-Agent-Type\":\"claude_code\"}}]}]"
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
  # D13/F57: below curl 7.55, -H "@$f" silently sends no auth header at all.
  ap_require_curl_755

  # D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
  # $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
  CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
  HOOKS_FILE="$CODEX_DIR/hooks.json"
  mkdir -p "$CODEX_DIR"

  echo "Configuring Codex CLI hooks..."

  # D13: the key never enters argv or the hooks file — the shim reads it
  # from this file at hook-fire time via curl -H "@$f".
  #
  # F207: never write through a symlink at the destination — a plain `>`
  # redirect follows one. Write to a sibling temp file (umask 077 -> 0600
  # on create) in the same directory, then atomically replace the
  # destination via mv: rename(2) replaces the directory entry itself, it
  # doesn't dereference a symlink there.
  mkdir -p "$HOME/.agentpulse"
  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  if [[ -L "$AP_AUTH_HEADER_FILE" ]]; then
    echo "refusing to write through a symlink: $AP_AUTH_HEADER_FILE" >&2
    exit 1
  fi
  AP_AUTH_HEADER_TMP="${AP_AUTH_HEADER_FILE}.$$.tmp"
  ( umask 077 && printf 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}" > "$AP_AUTH_HEADER_TMP" )
  mv -f "$AP_AUTH_HEADER_TMP" "$AP_AUTH_HEADER_FILE"

  NEW_CODEX_HOOKS_JSON="$(ap_codex_hooks_json "$AGENTPULSE_URL" "1")"
  if [[ -f "$HOOKS_FILE" ]] && [[ "$(cat "$HOOKS_FILE")" == "$NEW_CODEX_HOOKS_JSON" ]]; then
    echo "Codex hooks unchanged — no re-trust needed"
  else
    if [[ -f "$HOOKS_FILE" ]]; then
      CODEX_BACKUP_FILE="${HOOKS_FILE}.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$HOOKS_FILE" | ap_write_no_follow "$CODEX_BACKUP_FILE" || exit 1
      echo "Backed up existing $HOOKS_FILE to $CODEX_BACKUP_FILE"
    fi
    printf '%s\n' "$NEW_CODEX_HOOKS_JSON" | ap_write_no_follow "$HOOKS_FILE" || exit 1
    echo "Codex CLI hooks configured in $HOOKS_FILE"
    echo "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Re-trust after changing the AgentPulse URL or port."
  fi

  # D12: codex_hooks is a deprecated (but still-working) legacy alias for
  # [features].hooks — left alone if present, never newly written.

# ─── Copilot CLI Setup ───────────────────────────────────────────────

elif [[ "$AGENT_TYPE" == "copilot_cli" ]]; then
  # D8: Copilot's project-scoped hooks live in .github/hooks/, a path this
  # installer doesn't write — --scope project has nothing to do here.
  if [[ "$SCOPE" == "project" ]]; then
    echo "Error: --agent copilot_cli --scope project is not supported. Copilot CLI loads project-scoped hooks from .github/hooks/, which AgentPulse doesn't manage. Use the default global scope (~/.copilot/hooks/agentpulse.json)." >&2
    exit 1
  fi

  # D8: only write into a real Copilot install — never create config for a
  # tool that isn't there.
  if ! command -v copilot >/dev/null 2>&1 && [[ ! -d "$HOME/.copilot" ]]; then
    echo "Error: Copilot CLI not detected (no 'copilot' on PATH and no ~/.copilot directory). Install Copilot CLI first, then re-run this installer." >&2
    exit 1
  fi

  ap_require_curl_755

  COPILOT_DIR="$HOME/.copilot/hooks"
  COPILOT_HOOKS_FILE="$COPILOT_DIR/agentpulse.json"
  mkdir -p "$COPILOT_DIR"

  echo "Configuring Copilot CLI hooks..."

  mkdir -p "$HOME/.agentpulse"
  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  if [[ -L "$AP_AUTH_HEADER_FILE" ]]; then
    echo "refusing to write through a symlink: $AP_AUTH_HEADER_FILE" >&2
    exit 1
  fi
  AP_AUTH_HEADER_TMP="${AP_AUTH_HEADER_FILE}.$$.tmp"
  ( umask 077 && printf 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}" > "$AP_AUTH_HEADER_TMP" )
  mv -f "$AP_AUTH_HEADER_TMP" "$AP_AUTH_HEADER_FILE"

  NEW_COPILOT_HOOKS_JSON="$(ap_copilot_hooks_json "$AGENTPULSE_URL" "1")"
  if [[ -f "$COPILOT_HOOKS_FILE" ]] && [[ "$(cat "$COPILOT_HOOKS_FILE")" == "$NEW_COPILOT_HOOKS_JSON" ]]; then
    echo "Copilot hooks unchanged"
  else
    if [[ -f "$COPILOT_HOOKS_FILE" ]]; then
      COPILOT_BACKUP_FILE="${COPILOT_HOOKS_FILE}.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$COPILOT_HOOKS_FILE" | ap_write_no_follow "$COPILOT_BACKUP_FILE" || exit 1
      echo "Backed up existing $COPILOT_HOOKS_FILE to $COPILOT_BACKUP_FILE"
    fi
    printf '%s\n' "$NEW_COPILOT_HOOKS_JSON" | ap_write_no_follow "$COPILOT_HOOKS_FILE" || exit 1
    echo "Copilot CLI hooks configured in $COPILOT_HOOKS_FILE"
  fi

else
  echo "Error: Unknown agent type '$AGENT_TYPE'. Use 'claude_code', 'codex_cli', or 'copilot_cli'."
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
