#!/bin/bash
# AgentPulse hook for Codex CLI
# Reads hook event from stdin, forwards to relay, sets terminal title on SessionStart

RELAY="http://localhost:${AGENTPULSE_PORT:-4000}"
INPUT=$(cat)

# Forward the event to the relay (fire and forget)
curl -sf -X POST "${RELAY}/api/v1/hooks" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Type: codex_cli" \
  -d "$INPUT" > /dev/null 2>&1 &

# On SessionStart, look up the session name and set terminal title
EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)

if [ "$EVENT" = "SessionStart" ] && [ -n "$SESSION_ID" ]; then
  # Wait a moment for the session to be created with a name
  sleep 1
  NAME=$(curl -sf "${RELAY}/api/v1/sessions/${SESSION_ID}" 2>/dev/null \
    | grep -o '"displayName":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$NAME" ] && [ "$NAME" != "null" ]; then
    # Write session name to a file for shell prompt integration
    echo "$NAME" > ~/.agentpulse/current-session-name 2>/dev/null || true
    # Set terminal title via ANSI escape
    printf '\033]0;%s\007' "[$NAME] codex" > /dev/tty 2>/dev/null || true
  fi
fi

# Clear session name file on session end so prompt goes back to normal
if [ "$EVENT" = "SessionEnd" ] || [ "$EVENT" = "Stop" ]; then
  # Only clear on SessionEnd, not Stop (Stop fires every turn)
  if [ "$EVENT" = "SessionEnd" ]; then
    rm -f ~/.agentpulse/current-session-name 2>/dev/null || true
  fi
fi

exit 0
