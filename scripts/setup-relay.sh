#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────────
#  AgentPulse Relay Setup
#
#  For machines whose agents report to a remote AgentPulse server (k8s, a
#  VPS, another machine). Agents may only post hooks to localhost, so this
#  installs a small relay on localhost that forwards to the server.
#
#  This script:
#  1. Checks the API key with the server before writing anything
#  2. Installs the relay to ~/.agentpulse/relay.ts, with its config
#  3. Installs the Claude Code statusline to ~/.claude/statusline-agentpulse.sh
#  4. Runs the relay as a macOS LaunchAgent or a Linux systemd user service
#  5. Points Claude Code + Codex hooks at the relay
#
#  Usage (served by your AgentPulse server, which fills in its own URL):
#    curl -sSL https://your-server.example.com/setup-relay.sh | bash
#  Or from a checkout:
#    bash scripts/setup-relay.sh --url https://your-server.example.com
#
#  The API key comes from --key, else $AGENTPULSE_KEY, else the last run's
#  config. If there's none and the server needs one, it's asked for on the
#  terminal (input hidden), which keeps it out of shell history and argv.
#
#  Re-run it anytime to update the relay and statusline. The key, port and
#  Codex-names policy from the last run are kept unless you pass new ones.
#
#  API key scopes: the key needs "Hook ingest" and "Observe (read-only)". The
#  relay posts hooks (ingest) and reads the session list to sync names and
#  CLAUDE.md files (observe). "Manage" is optional; it lets the relay upload
#  CLAUDE.md edits. A key without Observe is refused unless you pass
#  --allow-missing-observe (hooks are forwarded, sync stays off).
# ───────────────────────────────────────────────────────

# One block: bash reads the whole script before running any of it, so
# `curl | bash` never runs a half-downloaded script, and an early exit doesn't
# leave curl writing into a closed pipe.
{

REMOTE_URL_DEFAULT=""
DEFAULT_PORT=4000
RELAY_DIR="$HOME/.agentpulse"
CONFIG_FILE="$RELAY_DIR/config.json"
KEY_RE='^[A-Za-z0-9._~+/-]+=*$'
# Where the key prompt reads from; tests point it elsewhere.
KEY_TTY="${AGENTPULSE_TTY:-/dev/tty}"

URL_ARG=""
KEY_ARG=""
PORT_ARG=""
CODEX_NAMES_ARG=""
ALLOW_MISSING_OBSERVE=false
BUN_PATH=""

# >>> agentpulse-hook-cmd
# D13: shared hook-command generators. Byte-identical to buildBashHookCommand/
# buildCodexHooksFile in src/shared/hook-command.ts (verified by
# scripts/hook-command-parity.test.ts) — this exact block also appears
# verbatim in scripts/setup-hooks.sh and the /setup.sh template served by
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
# synchronous path by design (D13), so the failure is invisible. Unused in
# THIS file — relay-mode hook commands never carry an auth header at all
# (direct=0; the relay adds auth when it forwards), and this file's own
# auth/me VERDICT check further up already gates on key validity before
# any file is written. Kept here anyway so the three marker-block copies
# stay byte-identical (see the header comment above).
#
# D39: fails CLOSED, not open. A key always skips the probe. With no key,
# only an explicit disableAuth:true in the response lets the install
# proceed — an unreachable server, a non-JSON response, or JSON missing
# the field all refuse now, same as a real disableAuth:false. $3=1
# (--no-auth-check) is the explicit escape hatch.
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
	echo "This server requires an API key; pass --key (or AGENTPULSE_KEY), or --no-auth-check if this server runs with auth disabled." >&2
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

usage() {
  cat <<'USAGE'
Usage: setup-relay.sh [--url <server_url>] [--key <api_key>] [--port 4000]
                      [--codex-names agentpulse|codex] [--allow-missing-observe]

  --url           Your AgentPulse server (filled in when the server serves this script)
  --key           API key with Hook ingest + Observe. Without it: $AGENTPULSE_KEY, the
                  last run's key, or a hidden prompt on the terminal
  --port          Local relay port (default 4000, or the last run's)
  --codex-names   codex (default): Codex's own thread names show on the dashboard.
                  agentpulse: dashboard names are written into Codex, replacing its
                  titles; renames made in Codex don't come back.
  --allow-missing-observe
                  Install with a key that lacks Observe (hooks only, no name/CLAUDE.md sync)
USAGE
}

fail() {
  echo "  ✗ $*" >&2
  exit 1
}

need_value() {
  if [[ -z "${2-}" || "${2-}" == --* ]]; then
    fail "$1 needs a value"
  fi
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --url) need_value "$1" "${2-}"; URL_ARG="$2"; shift 2 ;;
    --key) need_value "$1" "${2-}"; KEY_ARG="$2"; shift 2 ;;
    --port) need_value "$1" "${2-}"; PORT_ARG="$2"; shift 2 ;;
    --codex-names) need_value "$1" "${2-}"; CODEX_NAMES_ARG="$2"; shift 2 ;;
    --allow-missing-observe) ALLOW_MISSING_OBSERVE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

# Prints one field of the existing config.json, or nothing. Read-only.
existing_config() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  AP_CONFIG_FILE="$CONFIG_FILE" AP_FIELD="$1" python3 -c '
import json, os
try:
    with open(os.environ["AP_CONFIG_FILE"]) as f:
        cfg = json.load(f)
    value = cfg.get(os.environ["AP_FIELD"]) if isinstance(cfg, dict) else None
except Exception:
    value = None
if isinstance(value, (str, int)) and not isinstance(value, bool):
    print(str(value).replace("\n", " "))
' 2>/dev/null || true
}

REMOTE_URL="${URL_ARG:-${REMOTE_URL_DEFAULT:-$(existing_config remote_url)}}"
REMOTE_URL="${REMOTE_URL%/}"
if [[ -z "$REMOTE_URL" ]]; then
  usage >&2
  fail "--url is required (your AgentPulse server, e.g. https://your-server.example.com)"
fi
case "$REMOTE_URL" in
  http://*|https://*) ;;
  *) fail "the server URL must start with http:// or https:// (got $REMOTE_URL)" ;;
esac
[[ "$REMOTE_URL" != *[[:space:]]* ]] || fail "the server URL can't contain spaces"

check_key_format() {
  if [[ -n "$API_KEY" && ! "$API_KEY" =~ $KEY_RE ]]; then
    fail "the API key has characters an Authorization header can't carry"
  fi
}

API_KEY="${KEY_ARG:-${AGENTPULSE_KEY:-$(existing_config api_key)}}"
check_key_format

PORT="${PORT_ARG:-$(existing_config port)}"
PORT="${PORT:-$DEFAULT_PORT}"
if [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
  fail "--port must be a number from 1 to 65535 (got $PORT)"
fi

# F245: reject a malformed local hook URL before any hook JSON generation
# (PORT is already numeric-validated above; this is the same grammar check
# every site applies, for parity — see the marker block above).
ap_validate_hook_base_url "http://localhost:${PORT}" || fail "internal error: invalid local hook URL"

if [[ -n "$CODEX_NAMES_ARG" ]]; then
  POLICY="$CODEX_NAMES_ARG"
else
  POLICY="$(existing_config codex_name_policy)"
  case "$POLICY" in agentpulse|codex) ;; *) POLICY="codex" ;; esac
fi
case "$POLICY" in
  agentpulse|codex) ;;
  *) fail "--codex-names must be agentpulse or codex (got $POLICY)" ;;
esac

echo ""
echo "  AgentPulse Relay Setup"
echo "  ──────────────────────"
echo "  Remote:  $REMOTE_URL"
echo "  Local:   http://localhost:$PORT"
echo ""

# ── Check the key before writing anything (D10) ──

key_help() {
  echo "    Create a key in AgentPulse under Settings → API Keys with" >&2
  echo "    \"Hook ingest\" and \"Observe (read-only)\" checked, then re-run" >&2
  echo "    this command and paste the key when asked (or pass --key)." >&2
}

# F169: said before the key is sent anywhere it could be read in transit.
warn_if_plain_http() {
  [[ -n "$API_KEY" && "$REMOTE_URL" == http://* ]] || return 0
  local hostport="${REMOTE_URL#http://}" host
  hostport="${hostport%%/*}"
  case "$hostport" in
    \[*) host="${hostport%%]*}]" ;;
    *) host="${hostport%%:*}" ;;
  esac
  case "$host" in
    localhost|127.*|"[::1]") return 0 ;;
  esac
  echo "  ! $REMOTE_URL is plain http://: your API key and hook payloads cross the" >&2
  echo "    network unencrypted. Use an https:// URL if the server has one." >&2
}

# Sets VERDICT: ok, unknown (an older server that doesn't report scopes),
# rejected, missing:<scopes>, or what went wrong.
check_key() {
  local out
  warn_if_plain_http
  if [[ -n "$API_KEY" ]]; then
    out="$(printf 'Authorization: Bearer %s\n' "$API_KEY" \
      | curl -sS -m 15 -H @- -w '\n%{http_code}' "$REMOTE_URL/api/v1/auth/me" 2>&1)" \
      || fail "can't reach $REMOTE_URL: $(head -n 1 <<<"$out")"
  else
    out="$(curl -sS -m 15 -w '\n%{http_code}' "$REMOTE_URL/api/v1/auth/me" 2>&1)" \
      || fail "can't reach $REMOTE_URL: $(head -n 1 <<<"$out")"
  fi
  VERDICT="$(AP_CODE="${out##*$'\n'}" AP_BODY="${out%$'\n'*}" python3 -c '
import json, os
def done(verdict):
    print(verdict)
    raise SystemExit
code = os.environ["AP_CODE"]
if code in ("401", "403"):
    done("rejected")
if code != "200":
    done("http_" + code)
try:
    me = json.loads(os.environ["AP_BODY"])
except Exception:
    done("bad_response")
if not isinstance(me, dict):
    done("bad_response")
if me.get("disableAuth") is True:
    done("ok")
if me.get("authenticated") is False:
    done("missing:ingest,observe")
# F168: only an authenticated identity without scopes is an older server.
if me.get("authenticated") is not True:
    done("bad_response")
user = me.get("user") if isinstance(me.get("user"), dict) else {}
scopes = user.get("scopes")
if not isinstance(scopes, list):
    done("unknown")
scopes = [s for s in scopes if isinstance(s, str)]
full = "*" in scopes
manage = full or "manage" in scopes
missing = []
if not full and "ingest" not in scopes:
    missing.append("ingest")
if not manage and "observe" not in scopes:
    missing.append("observe")
done("missing:" + ",".join(missing) if missing else "ok")
')"
}

check_key
if [[ -z "$API_KEY" && "$VERDICT" == missing:* ]]; then
  # F167: asks on the terminal, not stdin (that's the script under
  # curl | bash). Inlined (not a $(...) function call) so the "did we
  # actually get to prompt" distinction below survives — a command
  # substitution forks a subshell, so a flag set inside one is lost.
  if { exec 3<"$KEY_TTY"; } 2>/dev/null; then
    printf '  API key (Hook ingest + Observe), input hidden: ' >&2
    IFS= read -rs API_KEY <&3 || true
    exec 3<&-
    printf '\n' >&2
    # F198: distinct from "couldn't prompt at all" below — the user was
    # asked and pressed Enter (or closed stdin) without typing anything.
    if [[ -z "$API_KEY" ]]; then
      echo "  ✗ No key entered." >&2
      key_help
      exit 1
    fi
  else
    echo "  ✗ This server needs an API key. Run this in a terminal to be asked for it," >&2
    echo "    or pass --key <key>, or set AGENTPULSE_KEY." >&2
    key_help
    exit 1
  fi
  check_key_format
  check_key
fi

case "$VERDICT" in
  ok)
    echo "  ✓ API key accepted" ;;
  unknown)
    echo "  ! The server didn't report the key's scopes (an older server); continuing" ;;
  rejected)
    echo "  ✗ The server rejected this API key." >&2
    key_help
    exit 1 ;;
  missing:*)
    MISSING="${VERDICT#missing:}"
    if [[ "$MISSING" == "observe" && "$ALLOW_MISSING_OBSERVE" == true ]]; then
      echo "  ! This key lacks Observe (read-only): hooks will be forwarded, but"
      echo "    session-name and CLAUDE.md sync stay off until you use a key with it."
    else
      if [[ "$MISSING" == "observe" ]]; then
        echo "  ✗ This API key can't run a relay: it's missing Observe (read-only)." >&2
      else
        echo "  ✗ This API key can't run a relay: it's missing Hook ingest and Observe (read-only)." >&2
      fi
      echo "    The relay forwards hooks (Hook ingest) and reads your session list to" >&2
      echo "    sync names and CLAUDE.md files (Observe)." >&2
      key_help
      echo "    To install anyway with hook forwarding only, add --allow-missing-observe." >&2
      exit 1
    fi ;;
  *)
    fail "unexpected answer from $REMOTE_URL/api/v1/auth/me ($VERDICT). Is that your AgentPulse server?" ;;
esac

# ── Stage the relay and statusline ──
# When the server serves this script, it writes both files into SRC_DIR right
# here; from a checkout, they're copied from beside this script.

SRC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentpulse-relay-setup.XXXXXX")"
trap 'rm -rf "$SRC_DIR"' EXIT

# @@AGENTPULSE_RELAY_TS@@
# @@AGENTPULSE_STATUSLINE_SH@@

if [[ ! -s "$SRC_DIR/relay.ts" || ! -s "$SRC_DIR/statusline.sh" ]]; then
  SELF="${BASH_SOURCE[0]:-}"
  SELF_DIR=""
  if [[ -n "$SELF" && -f "$SELF" ]]; then
    SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  fi
  if [[ -n "$SELF_DIR" && -f "$SELF_DIR/relay.ts" && -f "$SELF_DIR/statusline.sh" ]]; then
    cp "$SELF_DIR/relay.ts" "$SRC_DIR/relay.ts"
    cp "$SELF_DIR/statusline.sh" "$SRC_DIR/statusline.sh"
  else
    # F198: no --key in the example — that puts the key in argv/shell history.
    fail "relay.ts isn't next to this script. Run scripts/setup-relay.sh from an AgentPulse checkout, or: curl -sSL <server>/setup-relay.sh | bash (set \$AGENTPULSE_KEY first, or you'll be prompted for the key)"
  fi
fi

# ── Find Bun ──
# F190: the relay keeps its state files private (0600) through appendFile's
# `mode`, which Bun 1.1.30 ignores (F171). So the service only ever runs a Bun
# at or above the floor: the one on PATH, ~/.bun's, or a private copy of the
# pinned release in ~/.agentpulse/bun (installed if none qualifies, without
# touching the user's own Bun or shell profile).

BUN_VERSION="1.3.12"
BUN_MIN_VERSION="$BUN_VERSION"
PRIVATE_BUN_DIR="$RELAY_DIR/bun"

# True when version $1 is at least $2 (numeric x.y.z; anything else is false).
version_at_least() {
  local IFS=. i x y
  local -a have want
  read -r -a have <<<"${1%%[-+]*}"
  read -r -a want <<<"$2"
  for i in 0 1 2; do
    x="${have[i]:-0}"
    y="${want[i]:-0}"
    [[ "$x" =~ ^[0-9]+$ ]] || return 1
    if (( x > y )); then return 0; fi
    if (( x < y )); then return 1; fi
  done
  return 0
}

# F197: the Bun release asset for this machine. Args: os (`uname -s`), arch
# (`uname -m`), avx2 (yes/no — CPU supports AVX2), musl (yes/no — musl libc),
# rosetta (yes/no — x86_64 uname under Rosetta 2 on Apple Silicon). Echoes
# nothing for a platform with no pinned asset.
bun_asset_for() {
  local os="$1" arch="$2" avx2="$3" musl="$4" rosetta="$5"
  case "$os" in
    Darwin)
      if [[ "$arch" == "arm64" || "$rosetta" == "yes" ]]; then
        echo "darwin-aarch64"
      elif [[ "$arch" == "x86_64" ]]; then
        [[ "$avx2" == "yes" ]] && echo "darwin-x64" || echo "darwin-x64-baseline"
      fi ;;
    Linux)
      case "$arch" in
        x86_64|amd64)
          if [[ "$musl" == "yes" ]]; then
            [[ "$avx2" == "yes" ]] && echo "linux-x64-musl" || echo "linux-x64-musl-baseline"
          else
            [[ "$avx2" == "yes" ]] && echo "linux-x64" || echo "linux-x64-baseline"
          fi ;;
        aarch64|arm64)
          [[ "$musl" == "yes" ]] && echo "linux-aarch64-musl" || echo "linux-aarch64" ;;
      esac ;;
  esac
}

# SHA256 of the Bun 1.3.12 release zip for the given asset name — taken from
# https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/SHASUMS256.txt
# and independently re-verified by downloading and hashing each file.
# TO UPGRADE: bump BUN_VERSION above and every hash here together, from that
# release's own SHASUMS256.txt — re-download and re-hash at least one asset
# yourself rather than trusting the file alone (S-L2).
bun_asset_sha256() {
  case "$1" in
    darwin-aarch64) echo "6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c" ;;
    darwin-x64) echo "0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d" ;;
    darwin-x64-baseline) echo "cc4e22130c2bc2d944d3a286de08f2ed37fa74136e59760f3a4661e610246474" ;;
    linux-x64) echo "11dc3ee11bc1695e149737c6ca3d5619302cf4346e6b8a6ec7988967ef01ddc5" ;;
    linux-x64-baseline) echo "f8bb377a9ae93d44697ff91a2611164d2aedc9263415d623b0c3af24a6f55dab" ;;
    linux-x64-musl) echo "5a9f9a2102d4bd0d5210b4f6bd345151d2310623947085177c1b306e8587dce6" ;;
    linux-x64-musl-baseline) echo "a95e079aef96f1387b86e27b69f9a6babbd08154d9a59483f29d9de285b8e3ad" ;;
    linux-aarch64) echo "c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b" ;;
    linux-aarch64-musl) echo "731baab945bc471c17248ea375e66f71442879d2595c54045b3e861f4e8b9ab1" ;;
  esac
}

SEEN_BUNS=" "
for candidate in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun" "$PRIVATE_BUN_DIR/bin/bun"; do
  [[ -n "$candidate" && -x "$candidate" && "$SEEN_BUNS" != *" $candidate "* ]] || continue
  SEEN_BUNS+="$candidate "
  candidate_version="$("$candidate" --version 2>/dev/null | head -n 1 || true)"
  if version_at_least "$candidate_version" "$BUN_MIN_VERSION"; then
    BUN_PATH="$candidate"
    break
  fi
  echo "  ! Not using $candidate (Bun ${candidate_version:-of unknown version}): the relay needs Bun $BUN_MIN_VERSION or newer to keep its files private"
done

if [[ -z "$BUN_PATH" ]]; then
  echo "  Installing Bun $BUN_VERSION for the relay into $PRIVATE_BUN_DIR..."
  # F197: pin Bun to a specific release's *binary*, not just an installer
  # script — downloading github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/
  # directly and checking it against a hash pinned to that exact file means
  # nothing between here and the binary running is trusted on faith (S-L2/S-L3).
  BUN_UNAME_S="$(uname -s)"
  BUN_UNAME_M="$(uname -m)"
  BUN_ROSETTA="no"
  BUN_AVX2="no"
  BUN_MUSL="no"
  if [[ "$BUN_UNAME_S" == "Darwin" ]]; then
    [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" == "1" ]] && BUN_ROSETTA="yes"
    [[ "$(sysctl -n hw.optional.avx2_0 2>/dev/null)" == "1" ]] && BUN_AVX2="yes"
  elif [[ "$BUN_UNAME_S" == "Linux" ]]; then
    grep -qm1 avx2 /proc/cpuinfo 2>/dev/null && BUN_AVX2="yes"
    { command -v ldd &>/dev/null && ldd --version 2>&1 | grep -qi musl; } && BUN_MUSL="yes"
  fi
  BUN_ASSET="$(bun_asset_for "$BUN_UNAME_S" "$BUN_UNAME_M" "$BUN_AVX2" "$BUN_MUSL" "$BUN_ROSETTA")"
  [[ -n "$BUN_ASSET" ]] \
    || fail "no pinned Bun $BUN_VERSION release for this platform ($BUN_UNAME_S/$BUN_UNAME_M); install Bun $BUN_MIN_VERSION or newer yourself and re-run"
  BUN_ASSET_SHA256="$(bun_asset_sha256 "$BUN_ASSET")"

  BUN_ZIP_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${BUN_ASSET}.zip"
  BUN_ZIP_TMP="$(mktemp)"
  curl -fsSL "$BUN_ZIP_URL" -o "$BUN_ZIP_TMP" \
    || { rm -f "$BUN_ZIP_TMP"; fail "couldn't download Bun from $BUN_ZIP_URL"; }

  # Verify checksum before extracting (S-L2). The hash is computed and
  # compared here rather than with `-c`: macOS ships a BSD sha256sum first on
  # PATH that rejects GNU's --quiet, which made a good download look like a
  # mismatch. Without shasum or sha256sum, abort — do not silently skip
  # supply-chain verification on minimal environments (e.g. Alpine, CI runners).
  if command -v shasum &>/dev/null; then
    BUN_ZIP_ACTUAL="$(shasum -a 256 "$BUN_ZIP_TMP" | awk '{print $1}')"
  elif command -v sha256sum &>/dev/null; then
    BUN_ZIP_ACTUAL="$(sha256sum "$BUN_ZIP_TMP" | awk '{print $1}')"
  else
    rm -f "$BUN_ZIP_TMP"
    fail "no shasum or sha256sum found; install one (e.g. coreutils) and retry"
  fi
  if [[ "$BUN_ZIP_ACTUAL" != "$BUN_ASSET_SHA256" ]]; then
    rm -f "$BUN_ZIP_TMP"
    fail "the downloaded Bun release's checksum doesn't match the pinned one; not installing it"
  fi

  command -v unzip &>/dev/null \
    || { rm -f "$BUN_ZIP_TMP"; fail "unzip is required to install Bun; install it and retry"; }
  BUN_UNZIP_DIR="$(mktemp -d)"
  unzip -q "$BUN_ZIP_TMP" "bun-${BUN_ASSET}/bun" -d "$BUN_UNZIP_DIR" \
    || { rm -f "$BUN_ZIP_TMP"; rm -rf "$BUN_UNZIP_DIR"; fail "couldn't unzip the downloaded Bun release"; }
  rm -f "$BUN_ZIP_TMP"

  mkdir -p "$PRIVATE_BUN_DIR/bin"
  mv "$BUN_UNZIP_DIR/bun-${BUN_ASSET}/bun" "$PRIVATE_BUN_DIR/bin/bun"
  chmod +x "$PRIVATE_BUN_DIR/bin/bun"
  rm -rf "$BUN_UNZIP_DIR"

  BUN_PATH="$PRIVATE_BUN_DIR/bin/bun"
  version_at_least "$("$BUN_PATH" --version 2>/dev/null || true)" "$BUN_MIN_VERSION" \
    || fail "the Bun just installed at $BUN_PATH isn't $BUN_MIN_VERSION or newer"
fi
echo "  ✓ Bun: $BUN_PATH ($("$BUN_PATH" --version 2>/dev/null || true))"

# ── Install the relay ──

mkdir -p "$RELAY_DIR/logs"
chmod 700 "$RELAY_DIR"
cp "$SRC_DIR/relay.ts" "$RELAY_DIR/relay.ts"

# The key lives only in config.json (mode 600), never in argv, the plist or
# the unit. Existing keys this script doesn't manage are kept.
AP_CONFIG_FILE="$CONFIG_FILE" AP_URL="$REMOTE_URL" AP_KEY="$API_KEY" AP_PORT="$PORT" \
  AP_POLICY="$POLICY" python3 -c '
import json, os
path = os.environ["AP_CONFIG_FILE"]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        cfg = {}
except Exception:
    cfg = {}
cfg.update({
    "remote_url": os.environ["AP_URL"],
    "api_key": os.environ["AP_KEY"],
    "port": int(os.environ["AP_PORT"]),
    "codex_name_policy": os.environ["AP_POLICY"],
})
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
'
echo "  ✓ Relay installed to $RELAY_DIR/relay.ts"

if [[ -e "$RELAY_DIR/codex-hook.sh" || -L "$RELAY_DIR/codex-hook.sh" ]]; then
  rm -f "$RELAY_DIR/codex-hook.sh"
  echo "  ✓ Removed obsolete ~/.agentpulse/codex-hook.sh (nothing uses it any more)"
fi

# ── Statusline ──

CLAUDE_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_DIR"
cp "$SRC_DIR/statusline.sh" "$CLAUDE_DIR/statusline-agentpulse.sh"
chmod 755 "$CLAUDE_DIR/statusline-agentpulse.sh"
STATUSLINE_CMD="~/.claude/statusline-agentpulse.sh"
if [[ "$PORT" != "$DEFAULT_PORT" ]]; then
  STATUSLINE_CMD="AGENTPULSE_PORT=$PORT $STATUSLINE_CMD"
fi

# statusLine is set only when it's absent; someone else's is never replaced.
STATUSLINE_RESULT="$(AP_SETTINGS="$CLAUDE_DIR/settings.json" AP_CMD="$STATUSLINE_CMD" python3 -c '
import json, os, shutil
path = os.environ["AP_SETTINGS"]
want = {"type": "command", "command": os.environ["AP_CMD"]}
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
except Exception:
    settings = None
if not isinstance(settings, dict):
    print("unreadable")
elif settings.get("statusLine") is None:
    settings["statusLine"] = want
    tmp = path + ".agentpulse.tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)
    print("set")
elif settings["statusLine"] == want:
    print("same")
else:
    print("other")
')"
case "$STATUSLINE_RESULT" in
  set) echo "  ✓ Statusline installed and enabled (~/.claude/statusline-agentpulse.sh)" ;;
  same) echo "  ✓ Statusline updated (~/.claude/statusline-agentpulse.sh)" ;;
  *)
    echo "  ✓ Statusline installed at ~/.claude/statusline-agentpulse.sh"
    if [[ "$STATUSLINE_RESULT" == "other" ]]; then
      echo "    Your ~/.claude/settings.json already has a statusLine, so it was left alone."
    else
      echo "    ~/.claude/settings.json couldn't be read as JSON, so it was left alone."
    fi
    echo "    To use AgentPulse's, set:"
    echo "      \"statusLine\": {\"type\": \"command\", \"command\": \"$STATUSLINE_CMD\"}" ;;
esac
command -v jq >/dev/null 2>&1 || echo "  ! The statusline needs jq; install it to see session names there"

# ── Run the relay as a service ──

LOG_DIR="$RELAY_DIR/logs"
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin)
    PLIST_FILE="$HOME/Library/LaunchAgents/dev.agentpulse.relay.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>${RELAY_DIR}/relay.ts</string>
    <string>--config</string>
    <string>${CONFIG_FILE}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/relay.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/relay.err</string>
  <key>WorkingDirectory</key>
  <string>${RELAY_DIR}</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE"
    echo "  ✓ LaunchAgent installed (auto-starts on login)"
    ;;
  Linux)
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/agentpulse-relay.service" << EOF
[Unit]
Description=AgentPulse Relay
After=network.target

[Service]
ExecStart="${BUN_PATH}" "${RELAY_DIR}/relay.ts" --config "${CONFIG_FILE}"
WorkingDirectory=${RELAY_DIR}
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/relay.log
StandardError=append:${LOG_DIR}/relay.err

[Install]
WantedBy=default.target
EOF
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null; then
      systemctl --user enable agentpulse-relay >/dev/null 2>&1 || true
      systemctl --user restart agentpulse-relay
      echo "  ✓ systemd user service installed (auto-starts on login)"
    else
      echo "  ! systemd user services aren't available here. Start the relay yourself:"
      echo "      \"$BUN_PATH\" \"$RELAY_DIR/relay.ts\" --config \"$CONFIG_FILE\""
    fi
    ;;
  *)
    echo "  ! No service support for $OS_NAME. Start the relay yourself:"
    echo "      \"$BUN_PATH\" \"$RELAY_DIR/relay.ts\" --config \"$CONFIG_FILE\""
    ;;
esac

RELAY_UP=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    RELAY_UP=true
    break
  fi
  sleep 0.5
done
if [[ "$RELAY_UP" == true ]]; then
  echo "  ✓ Relay running on localhost:$PORT"
else
  echo "  ! Relay may not have started yet. Check: $LOG_DIR/relay.err"
fi

# ── Configure hooks ──

echo ""
echo "  Configuring agent hooks..."

# Claude Code
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

HOOKS_JSON="{"
for i in "${!EVENTS[@]}"; do
  EVENT="${EVENTS[$i]}"
  [[ $i -gt 0 ]] && HOOKS_JSON+=","
  HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"http://localhost:${PORT}/api/v1/hooks\",\"async\":true,\"headers\":{\"X-Agent-Type\":\"claude_code\"}}]}]"
done
HOOKS_JSON+="}"

if [[ -f "$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  jq --argjson hooks "$HOOKS_JSON" '.hooks = (.hooks // {}) * $hooks' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"
  mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
elif [[ -f "$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  python3 -c "
import json
with open('$CLAUDE_SETTINGS') as f: s = json.load(f)
h = json.loads('''$HOOKS_JSON''')
s.setdefault('hooks', {}).update(h)
with open('$CLAUDE_SETTINGS', 'w') as f: json.dump(s, f, indent=2)
"
else
  echo "{\"hooks\":$HOOKS_JSON}" > "$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks → localhost:$PORT"

# Codex CLI
# D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
# $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_DIR"

NEW_CODEX_HOOKS_JSON="$(ap_codex_hooks_json "http://localhost:${PORT}" "0")"
if [[ -f "$CODEX_DIR/hooks.json" ]] && [[ "$(cat "$CODEX_DIR/hooks.json")" == "$NEW_CODEX_HOOKS_JSON" ]]; then
  echo "  ✓ Codex hooks unchanged — no re-trust needed"
else
  if [[ -f "$CODEX_DIR/hooks.json" ]]; then
    CODEX_BACKUP_FILE="$CODEX_DIR/hooks.json.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cat "$CODEX_DIR/hooks.json" | ap_write_no_follow "$CODEX_BACKUP_FILE" || exit 1
    echo "  ✓ Backed up existing Codex hooks to $CODEX_BACKUP_FILE"
  fi
  printf '%s\n' "$NEW_CODEX_HOOKS_JSON" | ap_write_no_follow "$CODEX_DIR/hooks.json" || exit 1
  echo "  ✓ Codex CLI hooks → localhost:$PORT"
  echo "    Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
  echo "    Re-trust after changing the AgentPulse URL or port."
fi
# D12: codex_hooks is a deprecated (but still-working) legacy alias for
# [features].hooks — left alone if present, never newly written.

# Copilot CLI (D8): only written when copilot is detected — never create
# config for a tool that isn't installed.
COPILOT_WRITTEN="0"
if command -v copilot >/dev/null 2>&1 || [[ -d "$HOME/.copilot" ]]; then
  COPILOT_DIR="$HOME/.copilot/hooks"
  COPILOT_HOOKS_FILE="$COPILOT_DIR/agentpulse.json"
  mkdir -p "$COPILOT_DIR"

  NEW_COPILOT_HOOKS_JSON="$(ap_copilot_hooks_json "http://localhost:${PORT}" "0")"
  if [[ -f "$COPILOT_HOOKS_FILE" ]] && [[ "$(cat "$COPILOT_HOOKS_FILE")" == "$NEW_COPILOT_HOOKS_JSON" ]]; then
    echo "  ✓ Copilot hooks unchanged"
  else
    if [[ -f "$COPILOT_HOOKS_FILE" ]]; then
      COPILOT_BACKUP_FILE="$COPILOT_HOOKS_FILE.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$COPILOT_HOOKS_FILE" | ap_write_no_follow "$COPILOT_BACKUP_FILE" || exit 1
      echo "  ✓ Backed up existing Copilot hooks to $COPILOT_BACKUP_FILE"
    fi
    printf '%s\n' "$NEW_COPILOT_HOOKS_JSON" | ap_write_no_follow "$COPILOT_HOOKS_FILE" || exit 1
    echo "  ✓ Copilot CLI hooks → localhost:$PORT"
  fi
  COPILOT_WRITTEN="1"
fi

# D22: when the Codex/Copilot hooks were last written, so the relay can
# tell "installed but never fired" apart from "not used".
AP_INSTALLED="$RELAY_DIR/installed.json" AP_COPILOT_WRITTEN="$COPILOT_WRITTEN" python3 -c '
import json, os
from datetime import datetime, timezone
path = os.environ["AP_INSTALLED"]
try:
    with open(path) as f:
        state = json.load(f)
    if not isinstance(state, dict):
        state = {}
except Exception:
    state = {}
now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
state["codexHooksWrittenAt"] = now
if os.environ.get("AP_COPILOT_WRITTEN") == "1":
    state["copilotHooksWrittenAt"] = now
else:
    state.setdefault("copilotHooksWrittenAt", None)
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
'

# ── Done ──

echo ""
echo "  Relay setup complete."
echo "    Relay:      http://localhost:$PORT"
echo "    Dashboard:  $REMOTE_URL"
echo "    Codex names: $POLICY — pass --codex-names agentpulse|codex to change"
if [[ "$POLICY" == "agentpulse" ]]; then
  echo "      Dashboard names are written into Codex and replace its own titles."
fi
echo ""
echo "  Open a new Claude Code or Codex session to see it on the dashboard."
echo "  Re-run this command anytime to update the relay and statusline."
echo ""
echo "  Manage:"
case "$OS_NAME" in
  Darwin)
    echo "    Stop:    launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist"
    echo "    Start:   launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist" ;;
  Linux)
    echo "    Stop:    systemctl --user stop agentpulse-relay"
    echo "    Start:   systemctl --user start agentpulse-relay" ;;
esac
echo "    Logs:    tail -f ~/.agentpulse/logs/relay.log"
echo "    Status:  curl -s http://localhost:$PORT/api/v1/relay/diagnostics"
echo ""

}
