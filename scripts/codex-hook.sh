#!/bin/bash
# AgentPulse hook for Codex CLI
# Forwards events to relay AND writes session name into Codex's own database
# so it appears in Codex's built-in statusline/title

RELAY="http://localhost:${AGENTPULSE_PORT:-4000}"
CODEX_DB="$HOME/.codex/state_5.sqlite"
INPUT=$(cat)

# Forward the event to the relay (fire and forget)
curl -sf -X POST "${RELAY}/api/v1/hooks" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Type: codex_cli" \
  -d "$INPUT" > /dev/null 2>&1 &

# On SessionStart: look up the AgentPulse session name and write it
# into Codex's own thread title so it shows in Codex's UI
EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)

if [ "$EVENT" = "SessionStart" ] && [ -n "$SESSION_ID" ]; then
  (
    sleep 2  # Wait for AgentPulse to create the session with a name
    NAME=$(curl -sf "${RELAY}/api/v1/sessions/${SESSION_ID}" 2>/dev/null \
      | grep -o '"displayName":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$NAME" ] && [ "$NAME" != "null" ] && [ -f "$CODEX_DB" ]; then
      # Write the AgentPulse name as the Codex thread title
      sqlite3 "$CODEX_DB" "UPDATE threads SET title = '[$NAME]' WHERE id = '$SESSION_ID';" 2>/dev/null
      # Also write to file for other integrations
      echo "$NAME" > ~/.agentpulse/current-session-name 2>/dev/null
    fi
  ) &
fi

exit 0
