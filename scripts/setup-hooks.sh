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
# D39 (F246): explicit escape hatch for installing against a server that
# isn't reachable yet / whose auth/me can't be probed — otherwise
# ap_check_auth_before_write now refuses by default in that situation.
NO_AUTH_CHECK="0"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) AGENTPULSE_URL="$2"; shift 2 ;;
    --key) AGENTPULSE_KEY="$2"; shift 2 ;;
    --agent) AGENT_TYPE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --no-auth-check) NO_AUTH_CHECK="1"; shift ;;
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
      echo "  --no-auth-check  Skip the auth/me probe — for installing"
      echo "                   against a server that isn't reachable yet or that"
      echo "                   runs with auth disabled but can't be probed."
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

# F245 (High, codex r2 D38): same grammar as assertValidHookBaseUrl() in
# src/shared/hook-command.ts — bare http(s)://host[:port] or
# http(s)://[ipv6][:port], nothing else. The base URL is later embedded
# inside single-quoted curl text in the generated hook command (ap_hook_cmd
# below); a --url containing a quote, space, $(...), or backtick would
# persist as shell code in hooks.json/agentpulse.json and execute on the
# next hook fire. Call before any hook JSON generation at every site.
ap_validate_hook_base_url() {
	local url="$1"
	if [[ "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
		return 0
	fi
	if [[ "$url" =~ ^https?://\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$ ]]; then
		return 0
	fi
	echo "invalid AgentPulse base URL for a hook command: $url" >&2
	return 1
}

# F246 (High, codex r2 D38; tightened by D39): mirrors bin/cli.ts — with no
# key, against a server that requires auth, refuse before writing any
# command hooks. Without this, an auth-enabled server silently 401s every
# hook fire forever: the detached shim discards curl's output on its
# synchronous path by design (D13), so the failure is invisible.
#
# D39: fails CLOSED, not open. A key always skips the probe. With no key,
# only an explicit disableAuth:true in the response lets the install
# proceed — an unreachable server, a non-JSON response (e.g. a proxy's
# HTML error page), or JSON missing the field all refuse now, same as a
# real disableAuth:false. $3=1 (--no-auth-check) is the explicit escape
# hatch for installing before the server is up.
ap_check_auth_before_write() {
	local base="$1" key="$2" skip="${3:-}" body
	if [[ -n "$key" ]]; then
		return 0
	fi
	if [[ "$skip" == "1" ]]; then
		return 0
	fi
	if body="$(curl -sS -m 10 "${base}/api/v1/auth/me" 2>/dev/null)" && printf '%s' "$body" | python3 -c '
import json, sys
try:
    me = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if me.get("disableAuth") is True else 1)
'; then
		return 0
	fi
	echo "This server requires an API key; pass --key (or AGENTPULSE_KEY), or bypass this check if this server runs with auth disabled." >&2
	return 1
}

# F252 (Medium/High, xander D39 re-verify): the inline secret writers
# (hook-auth-header for Codex/Copilot, ~/.agentpulse/env) checked only the
# final path component for a symlink and called mkdir -p BEFORE checking
# — a symlinked ~/.agentpulse parent directory would let mkdir -p silently
# succeed and the secret land wherever the parent symlink points,
# unrefused. Ports F249's ordering: refuse if the parent is a symlink,
# THEN mkdir, THEN refuse if the file itself is a symlink, THEN the
# umask-077 temp write + mv. $2 is the exact file content, including any
# trailing newline the caller wants — printf '%s' writes it verbatim, no
# extra formatting here.
ap_write_private_no_follow() {
	local path="$1" content="$2" dir tmp
	dir="$(dirname -- "$path")"
	if [ -L "$dir" ]; then
		echo "refusing to write into a symlinked directory: $dir" >&2
		return 1
	fi
	mkdir -p "$dir"
	if [ -L "$path" ]; then
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	tmp="${path}.$$.tmp"
	( umask 077 && printf '%s' "$content" > "$tmp" )
	mv -f "$tmp" "$path"
}

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

# F245: reject a malformed --url before any hook JSON generation.
ap_validate_hook_base_url "$AGENTPULSE_URL" || exit 1

# F246: before any file writes, refuse if this server needs a key we don't have.
ap_check_auth_before_write "$AGENTPULSE_URL" "$AGENTPULSE_KEY" "$NO_AUTH_CHECK" || exit 1

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

  # AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
  # $AGENTPULSE_API_KEY from ITS OWN process environment, not the shell that
  # launched Claude Code -- a GUI, IDE, or stale-terminal launch never
  # sources ~/.agentpulse/env, so the env-var form 401s silently there.
  # Global (user) scope trades that reliability gap for embedding the
  # literal key -- acceptable because settings.json is tightened to 0600
  # below (never world-readable). Project scope (a repo's
  # .claude/settings.json, which may be committed) never gets a literal key
  # -- it keeps the env-var/allowedEnvVars form, at the cost of the same
  # silent-401 risk this trade accepts for global scope.
  HOOKS_JSON="{"
  for i in "${!EVENTS[@]}"; do
    EVENT="${EVENTS[$i]}"
    if [[ $i -gt 0 ]]; then
      HOOKS_JSON+=","
    fi
    if [[ "$SCOPE" == "global" ]]; then
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"headers\":{\"Authorization\":\"Bearer ${AGENTPULSE_KEY}\",\"X-Agent-Type\":\"claude_code\"}}]}]"
    else
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_API_KEY\"],\"headers\":{\"Authorization\":\"Bearer \$AGENTPULSE_API_KEY\",\"X-Agent-Type\":\"claude_code\"}}]}]"
    fi
  done
  HOOKS_JSON+="}"

  # F<new> (H2): refuse a symlinked destination or its parent directory
  # before any write. settings.json holds other user settings we must
  # preserve, so this can't just delegate to ap_write_private_no_follow
  # (which overwrites the whole file) -- same ordering as that helper:
  # parent symlink check, mkdir, then the file's own symlink check.
  SETTINGS_DIR="$(dirname "$SETTINGS_FILE")"
  if [[ -L "$SETTINGS_DIR" ]]; then
    echo "refusing to write into a symlinked directory: $SETTINGS_DIR" >&2
    exit 1
  fi
  mkdir -p "$SETTINGS_DIR"
  if [[ -L "$SETTINGS_FILE" ]]; then
    echo "refusing to write through a symlink: $SETTINGS_FILE" >&2
    exit 1
  fi

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
    echo "{\"hooks\":$HOOKS_JSON}" | python3 -m json.tool > "$SETTINGS_FILE" 2>/dev/null || echo "{\"hooks\":$HOOKS_JSON}" > "$SETTINGS_FILE"
  fi

  # H2: global (user) scope gets the literal key above, so its settings.json
  # is tightened to owner-only -- never world-readable. Project scope keeps
  # whatever mode the repo's file already had (it's meant to be shared/
  # committed, and never carries the literal key in the first place).
  if [[ "$SCOPE" == "global" && -f "$SETTINGS_FILE" ]]; then
    chmod 600 "$SETTINGS_FILE"
  fi

  echo "Claude Code hooks configured in $SETTINGS_FILE"
  if [[ "$SCOPE" == "project" ]]; then
    echo "Restart Claude Code fully to pick up the key -- an app launched from a GUI or an IDE may not see \$AGENTPULSE_API_KEY from your shell."
  fi

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
  # F207/F252: never write through a symlink at the destination or its
  # parent directory — see ap_write_private_no_follow above.
  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
  ap_write_private_no_follow "$AP_AUTH_HEADER_FILE" "$AP_AUTH_HEADER_CONTENT" || exit 1

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

  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
  ap_write_private_no_follow "$AP_AUTH_HEADER_FILE" "$AP_AUTH_HEADER_CONTENT" || exit 1

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

# ─── Environment Variable (D37/F243) ─────────────────────────────────
#
# codex_cli/copilot_cli never reach this point with anything to write:
# they authenticate hook fires via ~/.agentpulse/hook-auth-header (0600,
# written above), not an exported env var — skip the profile entirely.
# claude_code's hooks.json embeds the literal key directly when one was
# given (see the Claude Code Setup section above), but AGENTPULSE_API_KEY/
# AGENTPULSE_URL are still exported for the user's own shell/CLI use —
# formerly appended to the rc file in plaintext, which is world-readable
# by default on many systems. Now written to a 0600 ~/.agentpulse/env
# instead, with only a key-free, idempotent source line in the rc file.

if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  echo ""
  echo "Setting AGENTPULSE_API_KEY environment variable..."

  SHELL_NAME="$(basename "$SHELL")"
  if [[ "$SHELL_NAME" == "zsh" ]]; then
    PROFILE="$HOME/.zshrc"
  elif [[ "$SHELL_NAME" == "bash" ]]; then
    PROFILE="$HOME/.bashrc"
  else
    PROFILE="$HOME/.profile"
  fi

  if grep -q "^export AGENTPULSE_API_KEY=" "$PROFILE" 2>/dev/null; then
    echo "! $PROFILE already has a plaintext AGENTPULSE_API_KEY export from an" >&2
    echo "  earlier install. Leaving it, but it's world-readable by default on" >&2
    echo "  many systems — remove it by hand:" >&2
    echo "    sed -i.bak '/^export AGENTPULSE_API_KEY=/d' \"$PROFILE\"" >&2
  fi

  AP_ENV_FILE="$HOME/.agentpulse/env"
  printf -v AP_ENV_CONTENT 'export AGENTPULSE_API_KEY="%s"\nexport AGENTPULSE_URL="%s"\n' \
      "${AGENTPULSE_KEY}" "${AGENTPULSE_URL}"
  ap_write_private_no_follow "$AP_ENV_FILE" "$AP_ENV_CONTENT" || exit 1
  echo "Wrote AGENTPULSE_API_KEY/AGENTPULSE_URL to $AP_ENV_FILE (0600)"

  AP_SOURCE_LINE='[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"'
  if ! grep -qF "$AP_SOURCE_LINE" "$PROFILE" 2>/dev/null; then
    echo "" >> "$PROFILE"
    echo "# AgentPulse (key lives in ~/.agentpulse/env, not here)" >> "$PROFILE"
    echo "$AP_SOURCE_LINE" >> "$PROFILE"
    echo "Added a source line for ~/.agentpulse/env to $PROFILE"
  fi
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
echo "Setup complete!"
if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  echo "Restart your shell or run:"
  echo "  source $PROFILE"
  echo ""
fi
echo "Then start a new ${AGENT_TYPE} session to see it in AgentPulse."
