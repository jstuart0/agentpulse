#!/bin/bash
# AgentPulse statusline for Claude Code
# Shows the session's random name (e.g. "brave-falcon") so you can
# match this terminal tab to the AgentPulse dashboard.
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

# Look up the AgentPulse display name from the local relay
AGENTPULSE_PORT="${AGENTPULSE_PORT:-4000}"
NAME=""
if [ -n "$SESSION_ID" ]; then
  NAME=$(curl -sf "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SESSION_ID}" 2>/dev/null \
    | jq -r '.session.displayName // ""' 2>/dev/null)
fi

# Pull-only sync (F5): push Claude Code's native session name into
# AgentPulse's displayName when it's set and differs from what we just
# fetched. Fire-and-forget in the background so it never delays render;
# full stdout+stderr redirection is mandatory — everything this script
# prints is rendered verbatim in the statusline, and a stray curl
# progress/error line would corrupt the display.
if [ -n "$SESSION_ID" ] && [ -n "$NATIVE_NAME" ] && [ "$NATIVE_NAME" != "null" ] && [ "$NATIVE_NAME" != "$NAME" ]; then
  curl -sf -m 1 -X PUT "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SESSION_ID}/native-name" \
    -H "Content-Type: application/json" \
    -d "{\"name\":$(echo "$NATIVE_NAME" | jq -Rs .)}" \
    > /dev/null 2>&1 &
fi

if [ -n "$NAME" ] && [ "$NAME" != "null" ]; then
  echo -e "\033[36m[$MODEL]\033[0m \033[1;33m$NAME\033[0m | ${PCT}% ctx"
else
  echo -e "\033[36m[$MODEL]\033[0m ${SESSION_ID:0:8} | ${PCT}% ctx"
fi
