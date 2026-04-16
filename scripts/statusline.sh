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

# Look up the AgentPulse display name from the local relay
AGENTPULSE_PORT="${AGENTPULSE_PORT:-4000}"
NAME=""
if [ -n "$SESSION_ID" ]; then
  NAME=$(curl -sf "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SESSION_ID}" 2>/dev/null \
    | jq -r '.session.displayName // ""' 2>/dev/null)
fi

if [ -n "$NAME" ] && [ "$NAME" != "null" ]; then
  echo -e "\033[36m[$MODEL]\033[0m \033[1;33m$NAME\033[0m | ${PCT}% ctx"
else
  echo -e "\033[36m[$MODEL]\033[0m ${SESSION_ID:0:8} | ${PCT}% ctx"
fi
