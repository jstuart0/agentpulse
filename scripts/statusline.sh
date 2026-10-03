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

# Exclude rules. AGENTPULSE_SKIP is read exactly the way the hooks read it:
# trimmed of space, tab, CR and LF only, then compared (any case) with
# 1, true, yes, on. While it is set, this script sends nothing about the
# session: no name lookup and no name push.
SKIP_ACTIVE=false
SKIP_VALUE="${AGENTPULSE_SKIP:-}"
while [[ "$SKIP_VALUE" == [$' \t\r\n']* ]]; do SKIP_VALUE="${SKIP_VALUE#?}"; done
while [[ "$SKIP_VALUE" == *[$' \t\r\n'] ]]; do SKIP_VALUE="${SKIP_VALUE%?}"; done
case "$SKIP_VALUE" in
  1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss] | [Oo][Nn]) SKIP_ACTIVE=true; SAFE_ID="" ;;
esac

# Where this Claude Code session's hooks go. Claude Code runs the hooks of every
# settings level together, so every AgentPulse hook this session has counts: the
# user's ~/.claude/settings.json and, for the session's own project directory,
# .claude/settings.json and .claude/settings.local.json. A hook is one aimed at
# /api/v1/hooks: a loopback URL on the port probed below with no Authorization
# header is the local relay; a URL with a key header, or one at a real server, is
# direct reporting; a loopback URL on some other port is some other relay.
#   relay          every such hook goes to this relay and carries the skip header
#   relay-noskip   every such hook goes to this relay, but one does not carry
#                  AGENTPULSE_SKIP (the relay still applies path rules)
#   direct         at least one goes straight to a server (or a key file is named)
#   elsewhere      at least one goes to some other relay, none go direct
#   none           no such hook
#   unreadable     a settings file exists but cannot be read as JSON
# Any doubt is a mode that claims nothing: a wrong claim here is worse than none.
HOOKS_MODE=""

# One line per AgentPulse hook in a settings file: "<relay|elsewhere|direct> <skip|noskip>".
# The skip header counts only when it carries the variable (exactly that name:
# $AGENTPULSE_SKIPPED is another variable) and the variable is allowed through to
# the hook (Claude Code expands no other variable).
settings_hooks() {
  jq -r --arg port "$AGENTPULSE_PORT" '
    [ (.hooks // {}) | to_entries[] | .value | select(type == "array") | .[]
      | select(type == "object") | (.hooks // []) | select(type == "array") | .[]
      | select(type == "object" and .type == "http" and (.url | type) == "string")
      | . as $h
      | ($h.url | capture("^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*)://(?<auth>[^/?#@]*@)?(?<host>\\[[^\\]]*\\]|[^/:?#]*)(:(?<port>[0-9]*))?(?<path>/[^?#]*)?")?) as $u
      | select($u.path == "/api/v1/hooks")
      | { host: ($u.host | ascii_downcase),
          port: (if ($u.port // "") != "" then $u.port elif $u.scheme == "https" then "443" else "80" end),
          key: (($h.headers // {}) | type == "object" and (keys | map(ascii_downcase) | index("authorization")) != null),
          skip: ((($h.headers // {}) | type == "object"
                  and ([to_entries[] | select((.key | ascii_downcase) == "x-agentpulse-skip"
                        and (.value | type) == "string"
                        and (.value | test("\\$(AGENTPULSE_SKIP(?![A-Za-z0-9_])|\\{AGENTPULSE_SKIP\\})")))] | length > 0))
                 and (($h.allowedEnvVars // []) | type == "array" and index("AGENTPULSE_SKIP") != null)) }
    ] | .[]
    | (if (.host | IN("localhost", "127.0.0.1", "[::1]", "::1")) and (.key | not)
         then (if .port == $port then "relay" else "elsewhere" end)
         else "direct" end) + " " + (if .skip then "skip" else "noskip" end)' "$1" 2>/dev/null
}

# The settings files that are this session's: the user's (in CLAUDE_CONFIG_DIR when
# that is set and not empty, else ~/.claude), and the project's two (the project is
# wherever Claude Code says the session's directory is).
settings_files() {
  printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  local dir
  while IFS= read -r dir; do
    case "$dir" in
      /*) printf '%s\n%s\n' "$dir/.claude/settings.json" "$dir/.claude/settings.local.json" ;;
    esac
  done < <(printf '%s' "$input" | jq -r '[.workspace.project_dir?, .workspace.current_dir?, .cwd?] | map(select(type == "string")) | unique | .[]' 2>/dev/null)
}

compute_hooks_mode() {
  [ -n "$HOOKS_MODE" ] && return
  local file lines line any_direct=false any_elsewhere=false any_relay=false any_noskip=false unreadable=false
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    if grep -q hook-auth-header "$file" 2>/dev/null; then any_direct=true; continue; fi
    if ! lines=$(settings_hooks "$file"); then unreadable=true; continue; fi
    while IFS= read -r line; do
      case "$line" in
        "direct "*) any_direct=true ;;
        "elsewhere "*) any_elsewhere=true ;;
        "relay "*) any_relay=true ;;
      esac
      case "$line" in *" noskip") any_noskip=true ;; esac
    done <<< "$lines"
  done < <(settings_files)
  if [ "$unreadable" = true ]; then HOOKS_MODE=unreadable
  elif [ "$any_direct" = true ]; then HOOKS_MODE=direct
  elif [ "$any_elsewhere" = true ]; then HOOKS_MODE=elsewhere
  elif [ "$any_relay" = true ] && [ "$any_noskip" = true ]; then HOOKS_MODE=relay-noskip
  elif [ "$any_relay" = true ]; then HOOKS_MODE=relay
  else HOOKS_MODE=none
  fi
}

# One health probe answers two questions: is something relay-shaped listening,
# and does it say it applies exclude rules (an older relay has no such field)?
IS_RELAY=""
RELAY_ENFORCES=""
HEALTH_PROBED=false
probe_relay() {
  [ "$HEALTH_PROBED" = true ] && return
  HEALTH_PROBED=true
  local answer
  answer=$(curl -sf -m 1 "http://localhost:${AGENTPULSE_PORT}/api/v1/health" 2>/dev/null \
    | jq -r '[(.relay // false), (.enforcesExcludeRules // false)] | map(tostring) | join(" ")' 2>/dev/null)
  IS_RELAY="${answer%% *}"
  RELAY_ENFORCES="${answer##* }"
}

# "Not reported" is claimed only when the relay says it enforces rules AND
# this session's hooks point at it. Otherwise the session may well be sent
# (direct reporting next to a relay that only serves Codex, an older relay
# that ignores the rules), and a wrong claim here is worse than none.
# Path rules are applied by the relay whatever a hook sends; AGENTPULSE_SKIP
# only reaches the relay in a header, so that claim also needs every hook to
# carry it.
relay_covers_this_session() {
  probe_relay
  compute_hooks_mode
  [ "$IS_RELAY" = "true" ] && [ "$RELAY_ENFORCES" = "true" ] \
    && { [ "$HOOKS_MODE" = "relay" ] || [ "$HOOKS_MODE" = "relay-noskip" ]; }
}

relay_gets_skip() {
  relay_covers_this_session && [ "$HOOKS_MODE" = "relay" ]
}

# The hooks write an empty marker file while the rules file is invalid (they
# drop every event until it is fixed). A running relay is told apart from
# direct reporting by its health answer: direct-mode Claude Code keeps
# reporting, because only the relay and the command hooks can apply the rules,
# and a skip request in direct mode is only discarded when it reaches the
# server.
EXCLUDE_LINE=""
MARKER_PRESENT=false
if [ -e "$AGENTPULSE_DIR/exclude.invalid" ] || [ -L "$AGENTPULSE_DIR/exclude.invalid" ]; then
  MARKER_PRESENT=true
fi
if [ "$MARKER_PRESENT" = true ] || [ "$SKIP_ACTIVE" = true ]; then
  probe_relay
fi
if [ "$MARKER_PRESENT" = true ]; then
  if [ "$IS_RELAY" = "true" ]; then
    EXCLUDE_LINE="AgentPulse: paused, exclude rules invalid (run: agentpulse exclude check)"
  else
    EXCLUDE_LINE="AgentPulse: exclude rules invalid; Claude Code is still reporting (direct mode)"
  fi
elif [ "$SKIP_ACTIVE" = true ]; then
  if [ "$IS_RELAY" != "true" ]; then
    EXCLUDE_LINE="AgentPulse: skip requested; in direct mode the server discards it on arrival"
  elif relay_gets_skip; then
    EXCLUDE_LINE="AgentPulse: not reported (AGENTPULSE_SKIP)"
  elif compute_hooks_mode && [ "$HOOKS_MODE" = "direct" ]; then
    EXCLUDE_LINE="AgentPulse: skip requested; in direct mode the server discards it on arrival"
  fi
fi

# Look up the AgentPulse display name from the local relay. It's server data,
# so control characters are stripped before it reaches the terminal.
# The ask is for the name only (?fields=displayName): a few dozen bytes however
# long the session is, instead of the whole session detail (megabytes on a long
# one, which timed out and left the session id on the line). A server that
# predates that answers the whole detail, which holds the same
# .session.displayName, so nothing else has to change for it.
# The answer's status code is kept (curl -f would hide a 404's body): a relay that
# refuses an excluded session says so locally with 404 {"error":"excluded"}, and
# then nothing more is asked about the session, including the name push below.
# A 404 {"error":"unknown_session"} only means the relay has never seen the id.
# The last name seen for the session is kept in cache/name-<id>, used only when
# the lookup itself fails (no answer in time, a server error): a miss, an
# unknown session and an excluded one never show a remembered name.
NAME=""
EXCLUDED_BY_RELAY=false
NAME_CACHE_FILE=""
if [ -n "$SAFE_ID" ]; then
  NAME_CACHE_FILE="$AGENTPULSE_DIR/cache/name-$SAFE_ID"
  LOOKUP=$(curl -s -m 1 -w '\n%{http_code}' "http://localhost:${AGENTPULSE_PORT}/api/v1/sessions/${SAFE_ID}?fields=displayName" 2>/dev/null)
  LOOKUP_CODE="${LOOKUP##*$'\n'}"
  LOOKUP_BODY="${LOOKUP%$'\n'*}"
  if [ "$LOOKUP_CODE" = "404" ] && [ "$(printf '%s' "$LOOKUP_BODY" | jq -r '.error // ""' 2>/dev/null)" = "excluded" ]; then
    EXCLUDED_BY_RELAY=true
    SAFE_ID=""
  elif [ "$LOOKUP_CODE" = "200" ]; then
    NAME=$(printf '%s' "$LOOKUP_BODY" | jq -r '.session.displayName // ""' 2>/dev/null | tr -d '\000-\037\177')
    if [ -n "$NAME" ] && [ "$NAME" != "null" ]; then
      REMEMBERED=""
      [ -f "$NAME_CACHE_FILE" ] && REMEMBERED=$(cat "$NAME_CACHE_FILE" 2>/dev/null)
      if [ "$NAME" != "$REMEMBERED" ]; then
        { mkdir -p "$AGENTPULSE_DIR/cache" && printf '%s' "$NAME" > "$NAME_CACHE_FILE"; } 2>/dev/null
      fi
    fi
  elif [ "$LOOKUP_CODE" != "404" ] && [ -f "$NAME_CACHE_FILE" ]; then
    # No answer in time, a server error, anything but a clear "no such session".
    NAME=$(head -n 1 "$NAME_CACHE_FILE" 2>/dev/null | tr -d '\000-\037\177')
  fi
fi
if [ "$EXCLUDED_BY_RELAY" = true ] && [ -z "$EXCLUDE_LINE" ] && relay_covers_this_session; then
  EXCLUDE_LINE="AgentPulse: not reported (excluded)"
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
if [ -n "$EXCLUDE_LINE" ]; then
  printf ' \033[2m· %s\033[0m' "$EXCLUDE_LINE"
elif [ -n "$STATUS_LINE" ]; then
  printf ' \033[2m· agentpulse: %s\033[0m' "$STATUS_LINE"
fi
printf '\n'
