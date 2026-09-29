#!/bin/bash
# agentpulse-statusline
# AgentPulse statusline for Claude Code
# Shows the session's AgentPulse name (e.g. "brave-falcon") so you can
# match this terminal tab to the dashboard, plus a hint when the local relay
# reports a problem (its status file).
#
# Install:
#   chmod +x scripts/statusline.sh
#   Add to ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/.claude/statusline-agentpulse.sh" }

input=$(cat)

SESSION_ID=$(echo "$input" | jq -r '.session_id // ""')
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
NATIVE_NAME=$(echo "$input" | jq -r '.session_name // ""')

AGENTPULSE_PORT="${AGENTPULSE_PORT:-4000}"
AGENTPULSE_DIR="${AGENTPULSE_DIR:-$HOME/.agentpulse}"

# The id goes into URL paths and a cache filename, so only the characters a
# real session id uses are allowed. Anything else skips the network entirely:
# curl would squash "../" segments into a different relay path.
SAFE_ID=""
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9_-]*) ;;
  *) SAFE_ID="$SESSION_ID" ;;
esac

# Look up the AgentPulse display name from the local relay. It's server data,
# so control characters are stripped before it reaches the terminal.
NAME=""
if [ -n "$SAFE_ID" ]; then
  NAME=$(curl -sf -m 1 "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SAFE_ID}" 2>/dev/null \
    | jq -r '.session.displayName // ""' 2>/dev/null | tr -d '\000-\037\177')
fi

# Pull-only sync (F5): push Claude Code's native session name to AgentPulse
# once per distinct name. The cache records the last name the server accepted
# (200) or permanently refused (400); anything else (not yet ingested, rate
# limited, relay down) is retried on the next render. Backgrounded with all
# output discarded, because anything this script prints lands in the
# statusline verbatim.
if [ -n "$SAFE_ID" ] && [ -n "$NATIVE_NAME" ] && [ "$NATIVE_NAME" != "null" ]; then
  CACHE_DIR="$AGENTPULSE_DIR/cache"
  CACHE_FILE="$CACHE_DIR/native-name-$SAFE_ID"
  LAST_PUSHED=""
  [ -f "$CACHE_FILE" ] && LAST_PUSHED=$(cat "$CACHE_FILE" 2>/dev/null)
  if [ "$NATIVE_NAME" != "$LAST_PUSHED" ]; then
    (
      BODY="{\"name\":$(printf '%s' "$NATIVE_NAME" | jq -Rs .)}"
      CODE=$(curl -s -m 1 -o /dev/null -w '%{http_code}' -X PUT \
        "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SAFE_ID}/native-name" \
        -H "Content-Type: application/json" -d "$BODY")
      case "$CODE" in
        200 | 400) mkdir -p "$CACHE_DIR" && printf '%s' "$NATIVE_NAME" > "$CACHE_FILE" ;;
      esac
    ) > /dev/null 2>&1 &
  fi
fi

# D17: the relay writes one plain line to its status file while something
# needs the user's attention. Control characters are stripped so the file
# can't break the one-line statusline.
STATUS_LINE=""
if [ -s "$AGENTPULSE_DIR/status" ]; then
  STATUS_LINE=$(head -n 1 "$AGENTPULSE_DIR/status" 2>/dev/null | tr -d '\000-\037\177')
fi

if [ -n "$NAME" ] && [ "$NAME" != "null" ]; then
  printf '\033[36m[%s]\033[0m \033[1;33m%s\033[0m | %s%% ctx' "$MODEL" "$NAME" "$PCT"
else
  printf '\033[36m[%s]\033[0m %s | %s%% ctx' "$MODEL" "${SESSION_ID:0:8}" "$PCT"
fi
if [ -n "$STATUS_LINE" ]; then
  printf ' \033[2m· agentpulse: %s\033[0m' "$STATUS_LINE"
fi
printf '\n'
