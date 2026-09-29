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

# F167: asks on the terminal, not stdin (that's the script under curl | bash).
prompt_for_key() {
  local key=""
  if { exec 3<"$KEY_TTY"; } 2>/dev/null; then
    printf '  API key (Hook ingest + Observe), input hidden: ' >&2
    IFS= read -rs key <&3 || true
    exec 3<&-
    printf '\n' >&2
  fi
  printf '%s' "$key"
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
  API_KEY="$(prompt_for_key)"
  if [[ -z "$API_KEY" ]]; then
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
    fail "relay.ts isn't next to this script. Run scripts/setup-relay.sh from an AgentPulse checkout, or: curl -sSL <server>/setup-relay.sh | bash -s -- --key <key>"
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
  # Pin Bun to a specific release for reproducibility and supply-chain safety (S-L2/S-L3).
  #
  # HOW THIS WORKS:
  #   1. We download the bun.sh installer script and verify its SHA256 (pins the installer).
  #   2. We invoke it with "bun-v${BUN_VERSION}" which causes it to download that exact
  #      release zip from github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/.
  #
  # TO UPGRADE: bump BUN_VERSION and BUN_INSTALLER_SHA256 together.
  #   Fetch new SHA: curl -fsSL "https://bun.sh/install" | sha256sum
  #   Verify at:     https://github.com/oven-sh/bun/releases/tag/bun-v${BUN_VERSION}
  BUN_INSTALLER_URL="https://bun.sh/install"
  # SHA256 of the bun.sh/install script as of 2026-09-29. 1.1.30 was dropped
  # because its appendFile ignores `mode`, leaving relay state files 0644 (F171);
  # 1.3.12 matches the server image (Dockerfile).
  # Re-verify with: curl -fsSL "https://bun.sh/install" | sha256sum
  BUN_INSTALLER_SHA256="04882bf41679d49d9af108657a1e5515bf04fdf2940d12c0d0b1e5d79dc53be8"

  BUN_INSTALLER_TMP="$(mktemp)"
  curl -fsSL "$BUN_INSTALLER_URL" -o "$BUN_INSTALLER_TMP" \
    || { rm -f "$BUN_INSTALLER_TMP"; fail "couldn't download the Bun installer from $BUN_INSTALLER_URL"; }

  # Verify checksum before executing (S-L2). The hash is computed and compared
  # here rather than with `-c`: macOS ships a BSD sha256sum first on PATH that
  # rejects GNU's --quiet, which made a good download look like a mismatch.
  # Without shasum or sha256sum, abort — do not silently skip supply-chain
  # verification on minimal environments (e.g. Alpine, CI runners).
  if command -v shasum &>/dev/null; then
    BUN_INSTALLER_ACTUAL="$(shasum -a 256 "$BUN_INSTALLER_TMP" | awk '{print $1}')"
  elif command -v sha256sum &>/dev/null; then
    BUN_INSTALLER_ACTUAL="$(sha256sum "$BUN_INSTALLER_TMP" | awk '{print $1}')"
  else
    rm -f "$BUN_INSTALLER_TMP"
    fail "no shasum or sha256sum found; install one (e.g. coreutils) and retry"
  fi
  if [[ "$BUN_INSTALLER_ACTUAL" != "$BUN_INSTALLER_SHA256" ]]; then
    rm -f "$BUN_INSTALLER_TMP"
    fail "the Bun installer's checksum doesn't match the pinned one; not running it"
  fi

  # Pass "bun-v${BUN_VERSION}" so the installer downloads that exact release
  # from github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/ rather
  # than the latest release. BUN_INSTALL keeps it private to the relay, and
  # SHELL=/bin/sh stops it from adding itself to a shell profile.
  BUN_INSTALL="$PRIVATE_BUN_DIR" SHELL=/bin/sh bash "$BUN_INSTALLER_TMP" "bun-v${BUN_VERSION}" >/dev/null 2>&1 \
    || { rm -f "$BUN_INSTALLER_TMP"; fail "couldn't install Bun $BUN_VERSION"; }
  rm -f "$BUN_INSTALLER_TMP"
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
CODEX_DIR="$HOME/.codex"
mkdir -p "$CODEX_DIR"
CODEX_EVENTS=("SessionStart" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop" "SubagentStart" "SubagentStop" "PermissionRequest" "PreCompact" "PostCompact")
CODEX_HOOKS="["
for i in "${!CODEX_EVENTS[@]}"; do
  [[ $i -gt 0 ]] && CODEX_HOOKS+=","
  CODEX_HOOKS+="{\"event\":\"${CODEX_EVENTS[$i]}\",\"type\":\"http\",\"url\":\"http://localhost:${PORT}/api/v1/hooks\",\"async\":true,\"headers\":{\"X-Agent-Type\":\"codex_cli\"}}"
done
CODEX_HOOKS+="]"
echo "{\"hooks\":$CODEX_HOOKS}" > "$CODEX_DIR/hooks.json"
# Hooks are stable and enabled by default since codex-cli 0.124.0; codex_hooks
# is a recognized legacy alias for the `hooks` feature, written for
# compatibility with older codex-cli installs that still gate on it.
if [[ -f "$CODEX_DIR/config.toml" ]]; then
  grep -q "codex_hooks" "$CODEX_DIR/config.toml" || echo -e "\n[features]\ncodex_hooks = true" >> "$CODEX_DIR/config.toml"
else
  echo -e "[features]\ncodex_hooks = true" > "$CODEX_DIR/config.toml"
fi
echo "  ✓ Codex CLI hooks → localhost:$PORT"

# D22: when the Codex hooks were last written, so the relay can tell
# "installed but never fired" apart from "not used".
AP_INSTALLED="$RELAY_DIR/installed.json" python3 -c '
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
