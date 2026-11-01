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
#    curl -fsSL --proto '=https' https://your-server.example.com/setup-relay.sh | bash
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

# A trailing slash on HOME would put "//" in every path derived from it.
while [[ "$HOME" == */ && "$HOME" != / ]]; do HOME="${HOME%/}"; done

REMOTE_URL_DEFAULT=""
DEFAULT_PORT=4000
RELAY_DIR="${HOME%/}/.agentpulse"
# Set here, with RELAY_DIR, because the Bun check below runs before the rest of the setup.
PRIVATE_BUN_DIR="$RELAY_DIR/bun"
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
#
# AGEN-21 (xander, High): the old `tmp="${path}.$$.tmp"` is predictable —
# an attacker doesn't need to win any race, just pre-plant a symlink at
# every plausible PID's tmp name before the script ever runs; the old
# `> "$tmp"` then follows straight through it. mktemp's XXXXXX suffix is
# unguessable and O_CREAT|O_EXCL under the hood (atomic — refuses if
# anything, symlink or not, already exists at that exact random path), so
# nothing can be pre-planted at it. The `[ -L "$tmp" ]` check afterward and
# `set -C`'s noclobber are belt-and-suspenders, not the primary defense: an
# environment with no mktemp falls back to a PID+$RANDOM name plus its own
# noclobber create-or-fail (uniqueness, not the atomicity mktemp gives).
ap_write_private_no_follow() {
	local path="$1" content="$2" dir tmp
	dir="$(dirname -- "$path")"
	if [ -L "$dir" ]; then
		echo "refusing to write into a symlinked directory: $dir" >&2
		return 1
	fi
	( umask 077 && mkdir -p "$dir" )
	if [ -L "$path" ]; then
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	if command -v mktemp >/dev/null 2>&1; then
		tmp="$(mktemp "${dir}/.$(basename -- "$path").XXXXXX")" || {
			echo "refusing: could not create a private temp file in $dir" >&2
			return 1
		}
	else
		tmp="${dir}/.$(basename -- "$path").$$.${RANDOM}${RANDOM}.tmp"
		if ! ( umask 077 && set -C && : > "$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a private temp file: $tmp" >&2
			return 1
		fi
	fi
	if [ -L "$tmp" ]; then
		echo "refusing to write through a symlink: $tmp" >&2
		return 1
	fi
	if ! ( set -C && printf '%s' "$content" >| "$tmp" ); then
		echo "refusing: could not write private temp file: $tmp" >&2
		rm -f -- "$tmp" 2>/dev/null || true
		return 1
	fi
	mv -f -- "$tmp" "$path"
}

# The exclusion check: ONE script, ~/.agentpulse/exclude-check.sh, written once by
# ap_install_exclude_script and run by the hook command's gate only when a rules
# file exists (src/shared/hook-command.ts, buildBashExcludeScript). Carried as
# ASCII text with three placeholders for the characters the check needs as real
# bytes (tab, carriage return, byte order mark), so no editor or line-ending
# conversion can change them; restored here.
ap_load_exclude_script() {
	IFS= read -r -d '' ap_exclude_script_text <<'AP_EXCLUDE_SCRIPT_EOF' || true
#!/bin/sh
# agentpulse-exclude-check 1eceddec1f369c
# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you
# and not group- or world-writable. Only that directory and this file are checked, not the
# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users
# can write is not protected.
ap_dir="$HOME/.agentpulse"
ap_rules="$ap_dir/exclude"
ap_marker="$ap_dir/exclude.invalid"
ap_excluded=0
ap_valid=1
ap_dir_ok=1
ap_match=0
ap_nrules=0
ap_cr='@@AP_CR@@'
ap_bom='@@AP_BOM@@'
ap_trimset=" @@AP_TAB@@$ap_cr
"
ap_ascii='] !"#$%&'\''()*+,./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\^_`abcdefghijklmnopqrstuvwxyz{|}~-'
ap_is_darwin=0
if [ -d /System/Library/CoreServices ]; then ap_is_darwin=1; fi

ap_lower() {
  ap_lc_in="$1"
  ap_lc_out=""
  while :; do
    case "$ap_lc_in" in
      *[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*) : ;;
      *) break ;;
    esac
    ap_lc_pre=${ap_lc_in%%[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*}
    ap_lc_in=${ap_lc_in#"$ap_lc_pre"}
    ap_lc_c=${ap_lc_in%"${ap_lc_in#?}"}
    ap_lc_in=${ap_lc_in#?}
    case "$ap_lc_c" in
      A) ap_lc_c=a ;; B) ap_lc_c=b ;; C) ap_lc_c=c ;; D) ap_lc_c=d ;; E) ap_lc_c=e ;;
      F) ap_lc_c=f ;; G) ap_lc_c=g ;; H) ap_lc_c=h ;; I) ap_lc_c=i ;; J) ap_lc_c=j ;;
      K) ap_lc_c=k ;; L) ap_lc_c=l ;; M) ap_lc_c=m ;; N) ap_lc_c=n ;; O) ap_lc_c=o ;;
      P) ap_lc_c=p ;; Q) ap_lc_c=q ;; R) ap_lc_c=r ;; S) ap_lc_c=s ;; T) ap_lc_c=t ;;
      U) ap_lc_c=u ;; V) ap_lc_c=v ;; W) ap_lc_c=w ;; X) ap_lc_c=x ;; Y) ap_lc_c=y ;;
      Z) ap_lc_c=z ;;
    esac
    ap_lc_out="$ap_lc_out$ap_lc_pre$ap_lc_c"
  done
  ap_lc_out="$ap_lc_out$ap_lc_in"
}

ap_stat() {
  ap_stat_mode=""
  ap_stat_line=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$1" 2>/dev/null) || return 1
  IFS=" " read -r ap_stat_mode ap_stat_nlink ap_stat_uid ap_stat_gid ap_stat_size ap_stat_tail <<AP_STAT_EOF
$ap_stat_line
AP_STAT_EOF
  ap_stat_m=$ap_stat_mode
  case "$ap_stat_m" in *[@+.]) ap_stat_m=${ap_stat_m%?} ;; esac
  case "$ap_stat_m" in
    [-dlcbpsDw?][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]) : ;;
    *) return 1 ;;
  esac
  case "$ap_stat_nlink" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_uid" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_size" in ""|*[!0-9]*) return 1 ;; esac
  ap_stat_rest=${ap_stat_m#?????}
  ap_stat_gw=${ap_stat_rest%"${ap_stat_rest#?}"}
  ap_stat_rest2=${ap_stat_m#????????}
  ap_stat_ow=${ap_stat_rest2%"${ap_stat_rest2#?}"}
  return 0
}

ap_physical() {
  if [ "$ap_is_darwin" = "1" ]; then
    case "$1" in
      *[!"$ap_ascii"]*) /bin/pwd -P 2>/dev/null; return ;;
    esac
  fi
  pwd -P 2>/dev/null
}

ap_skip_raw=${AGENTPULSE_SKIP:-}
while :; do
  case "$ap_skip_raw" in
    *["$ap_trimset"]) ap_skip_raw=${ap_skip_raw%?} ;;
    *) break ;;
  esac
done
while :; do
  case "$ap_skip_raw" in
    ["$ap_trimset"]*) ap_skip_raw=${ap_skip_raw#?} ;;
    *) break ;;
  esac
done
case "$ap_skip_raw" in
  [1]|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) ap_excluded=1 ;;
esac

ap_present=0
if [ "$ap_excluded" != "1" ]; then
  if [ -z "$HOME" ]; then
    ap_excluded=1
  elif [ -e "$ap_rules" ] || [ -L "$ap_rules" ]; then
    ap_present=1
  else
    case "$ap_dir" in /*) ap_wp="" ;; *) ap_wp="." ;; esac
    ap_wrest=${ap_dir#/}
    while [ -n "$ap_wrest" ]; do
      case "$ap_wrest" in
        */*)
          ap_wseg=${ap_wrest%%/*}
          ap_wrest=${ap_wrest#*/}
          ;;
        *)
          ap_wseg="$ap_wrest"
          ap_wrest=""
          ;;
      esac
      if [ -z "$ap_wseg" ]; then continue; fi
      ap_wp="$ap_wp/$ap_wseg"
      if [ -L "$ap_wp" ] && [ ! -e "$ap_wp" ]; then ap_present=1; break; fi
      if [ -d "$ap_wp" ]; then
        if [ ! -x "$ap_wp" ]; then ap_present=1; break; fi
      else
        break
      fi
    done
  fi
fi

ap_check_dir() {
  ap_dir_ok=1
  if [ -L "$ap_dir" ]; then
    ap_dir_real=$(cd "$ap_dir" 2>/dev/null && pwd -P 2>/dev/null)
  else
    ap_dir_real="$ap_dir"
  fi
  if [ -z "$ap_dir_real" ] || [ ! -d "$ap_dir_real" ] || [ ! -x "$ap_dir_real" ]; then
    ap_dir_ok=0
  else
    ap_my_uid=$(id -u 2>/dev/null)
    case "$ap_my_uid" in ""|*[!0-9]*) ap_dir_ok=0 ;; esac
    if ap_stat "$ap_dir_real"; then
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_dir_ok=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_dir_ok=0; fi
    else
      ap_dir_ok=0
    fi
  fi
}

if [ "$ap_present" != "1" ] && [ "$ap_excluded" != "1" ]; then
  if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then
    ap_check_dir
    if [ "$ap_dir_ok" = "1" ]; then rm -f "$ap_dir_real/exclude.invalid" 2>/dev/null; fi
  fi
fi

if [ "$ap_present" = "1" ]; then
  ap_check_dir
  ap_valid=$ap_dir_ok
  ap_marker="$ap_dir_real/exclude.invalid"

  if [ "$ap_valid" = "1" ]; then
    if [ -L "$ap_rules" ]; then
      ap_valid=0
    elif [ ! -f "$ap_rules" ]; then
      ap_valid=0
    elif ap_stat "$ap_rules"; then
      if [ "$ap_stat_nlink" -gt 1 ]; then ap_valid=0; fi
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_valid=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ ! -r "$ap_rules" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ "$ap_stat_size" -gt 65536 ]; then ap_valid=0; fi
    else
      ap_valid=0
    fi
  fi

  if [ "$ap_valid" = "1" ]; then
    ap_cwd=$(pwd -P 2>/dev/null)
    if [ -n "$ap_cwd" ] && [ ! -d "$ap_cwd" ]; then ap_cwd=""; fi
    if [ "$ap_is_darwin" = "1" ]; then
      case "$ap_cwd" in
        *[!"$ap_ascii"]*) ap_cwd=$(/bin/pwd -P 2>/dev/null) ;;
      esac
      ap_lower "$ap_cwd"
      ap_cwd="$ap_lc_out"
    fi

    ap_line_no=0
    ap_read_ok=0
    {
    while IFS= read -r ap_line || [ -n "$ap_line" ]; do
      ap_line_no=$((ap_line_no + 1))
      case "$ap_line" in *"$ap_cr") ap_line=${ap_line%"$ap_cr"} ;; esac
      if [ "$ap_line_no" = "1" ]; then
        case "$ap_line" in "$ap_bom"*) ap_line=${ap_line#"$ap_bom"} ;; esac
      fi
      while :; do
        case "$ap_line" in
          *["$ap_trimset"]) ap_line=${ap_line%?} ;;
          *) break ;;
        esac
      done
      case "$ap_line" in
        "") continue ;;
        "#"*) continue ;;
      esac
      ap_nrules=$((ap_nrules + 1))
      if [ "$ap_nrules" -gt 500 ]; then ap_valid=0; break; fi
      case "$ap_line" in
        *'*'*|*'?'*|*'['*|*']'*) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        /*) : ;;
        "~") : ;;
        "~/"*) : ;;
        *) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        "~") ap_expanded="$HOME" ;;
        "~/"*) ap_expanded="$HOME/${ap_line#\~/}" ;;
        *) ap_expanded="$ap_line" ;;
      esac
      case "/$ap_expanded/" in
        *"/./"*|*"/../"*) ap_valid=0; break ;;
      esac
      if [ "$ap_match" = "1" ]; then continue; fi

      ap_seg_rest=${ap_expanded#/}
      ap_prefix=""
      ap_needs_resolve=0
      ap_deepest=""
      ap_remainder=""
      while [ -n "$ap_seg_rest" ]; do
        case "$ap_seg_rest" in
          */*)
            ap_seg=${ap_seg_rest%%/*}
            ap_seg_rest=${ap_seg_rest#*/}
            ;;
          *)
            ap_seg="$ap_seg_rest"
            ap_seg_rest=""
            ;;
        esac
        if [ -z "$ap_seg" ]; then continue; fi
        ap_prefix="$ap_prefix/$ap_seg"
        if [ -L "$ap_prefix" ]; then ap_needs_resolve=1; fi
        if [ -e "$ap_prefix" ]; then
          ap_deepest="$ap_prefix"
          ap_remainder=""
        else
          ap_remainder="$ap_remainder/$ap_seg"
        fi
      done
      if [ -z "$ap_prefix" ]; then ap_prefix="/"; fi
      if [ "$ap_is_darwin" = "1" ]; then
        case "$ap_deepest" in
          *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-]*)
            case "$ap_deepest" in
              *[!"$ap_ascii"]*) ap_needs_resolve=1 ;;
            esac ;;
        esac
      fi

      if [ "$ap_needs_resolve" = "1" ]; then
        ap_rt="${ap_deepest:-/}"
        ap_rrem="$ap_remainder"
        while :; do
          ap_resolved=$(cd "$ap_rt" 2>/dev/null && ap_physical "$ap_rt")
          if [ -n "$ap_resolved" ]; then break; fi
          if [ "$ap_rt" = "/" ]; then ap_resolved="/"; break; fi
          ap_rrem="/${ap_rt##*/}$ap_rrem"
          ap_rt=${ap_rt%/*}
          if [ -z "$ap_rt" ]; then ap_rt="/"; fi
        done
        if [ "$ap_resolved" = "/" ]; then ap_resolved=""; fi
        ap_resolved="$ap_resolved$ap_rrem"
        if [ -z "$ap_resolved" ]; then ap_resolved="/"; fi
      else
        ap_resolved="$ap_prefix"
      fi

      if [ "$ap_is_darwin" = "1" ]; then
        ap_lower "$ap_resolved"
        ap_resolved="$ap_lc_out"
      fi

      if [ "$ap_resolved" = "/" ]; then
        ap_match=1
      elif [ "$ap_cwd" = "$ap_resolved" ]; then
        ap_match=1
      else
        ap_rem=${ap_cwd#"$ap_resolved"/}
        if [ "$ap_rem" != "$ap_cwd" ]; then ap_match=1; fi
      fi
    done
    ap_read_ok=1
    } 2>/dev/null < "$ap_rules"
    if [ "$ap_read_ok" != "1" ]; then ap_valid=0; fi
    if [ "$ap_valid" = "1" ] && [ "$ap_nrules" -gt 0 ] && [ -z "$ap_cwd" ]; then ap_match=1; fi
  fi

  if [ "$ap_valid" = "1" ]; then
    if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then rm -f "$ap_marker" 2>/dev/null; fi
    if [ "$ap_match" = "1" ]; then ap_excluded=1; fi
  else
    if [ "$ap_dir_ok" = "1" ] && [ ! -L "$ap_marker" ]; then { :; } 2>/dev/null >"$ap_marker"; fi
    ap_excluded=1
  fi
fi
if [ "$ap_excluded" = "1" ]; then exit 1; fi
exit 42
AP_EXCLUDE_SCRIPT_EOF
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_TAB@@/$'\t'}
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_CR@@/$'\r'}
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_BOM@@/$'\xef\xbb\xbf'}
}

# The two pieces of the hook command that carry logic (src/shared/hook-command.ts:
# CODEX_MARKER_SH_PIECE and SH_GATE_PIECE), stored verbatim.
ap_load_hook_pieces() {
	IFS= read -r -d '' ap_marker_piece <<'AP_MARKER_PIECE_EOF' || true
sid=$(grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' "$t" | head -n1); sid=${sid%\"}; sid=${sid##*\"}; case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ ${#sid} -le 128 ] && [ ! -L "$HOME/.agentpulse/codex-native" ]; then mkdir -p "$HOME/.agentpulse/codex-native" 2>/dev/null; set -C; { :; } 2>/dev/null >"$HOME/.agentpulse/codex-native/$sid"; set +C; fi ;; esac; 
AP_MARKER_PIECE_EOF
	ap_marker_piece=${ap_marker_piece%$'\n'}
	IFS= read -r -d '' ap_gate_piece <<'AP_GATE_PIECE_EOF' || true
w=$(printf ' \t\r\n.'); w=${w%.}; x=${AGENTPULSE_SKIP:-}; y=${x%%[!"$w"]*}; x=${x#"$y"}; y=${x##*[!"$w"]}; x=${x%"$y"}; case $x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=$HOME/.agentpulse; g=0; if [ -n "$HOME" ] && [ ! -e "$d/exclude" ] && [ ! -L "$d/exclude" ] && [ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]; then if [ -d "$d" ] && [ -x "$d" ]; then g=1; elif [ ! -e "$d" ] && [ ! -L "$d" ] && [ -d "$HOME" ] && [ -x "$HOME" ]; then g=1; fi; fi; if [ "$g" != 1 ]; then l=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$d/" "$d/exclude-check.sh" 2>/dev/null) || exit 0; u=$(id -u 2>/dev/null); ap_f() { y=${x%%[!" "]*}; x=${x#"$y"}; y=${x%%" "*}; x=${x#"$y"}; }; ap_v() { x=$1; ap_f; k=${y%[@+.]}; ap_f; ap_f; [ -n "$y" ] && [ "$y" = "$u" ] && case $k in $2[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=${w#???}; ap_v "${l%%"$n"*}" d && ap_v "${l#*"$n"}" - && { /bin/sh "$d/exclude-check.sh"; [ $? = 42 ]; } || exit 0; fi; 
AP_GATE_PIECE_EOF
	ap_gate_piece=${ap_gate_piece%$'\n'}
}

# Installs (or refreshes) the check at ~/.agentpulse/exclude-check.sh: atomic
# (temp file in the same directory, then rename), never through a link, mode
# 0500. A missing ~/.agentpulse is created 0700; an existing one is never
# loosened, and is used only when it (or what a symlink resolves to) is a
# directory you own that nobody else can write. Anything else prints a warning
# and installs nothing: hooks still work, and a rules file then makes them send
# nothing (fail closed) until the check is installed.
ap_install_exclude_script() {
	local dir="$HOME/.agentpulse" real tmp perms
	if [ -z "$HOME" ]; then
		echo "! Exclusion check not installed: HOME is not set." >&2
		return 0
	fi
	if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
		if ! ( umask 077 && mkdir "$dir" ) 2>/dev/null; then
			echo "! Exclusion check not installed: could not create $dir." >&2
			return 0
		fi
	fi
	real="$(cd -P "$dir" 2>/dev/null && pwd -P)" || real=""
	perms="$(ls -ld "$real" 2>/dev/null)" || perms=""
	if [ -z "$real" ] || [ ! -d "$real" ] || [ ! -O "$real" ] || [ "${perms:5:1}" != "-" ] || [ "${perms:8:1}" != "-" ]; then
		echo "! Exclusion check not installed: $dir must be a directory you own that nobody else can write." >&2
		return 0
	fi
	if [ -L "$real/exclude-check.sh" ] || [ -d "$real/exclude-check.sh" ]; then
		echo "! Exclusion check not installed: $real/exclude-check.sh is a link or a directory; remove it and run this again." >&2
		return 0
	fi
	if ! command -v mktemp >/dev/null 2>&1; then
		echo "! Exclusion check not installed: mktemp not found." >&2
		return 0
	fi
	ap_load_exclude_script
	# A current copy (same text, mode 0500, ours) is left alone, like the TypeScript installer does.
	if [ -f "$real/exclude-check.sh" ] && [ -O "$real/exclude-check.sh" ] \
		&& [ "$(ls -ld "$real/exclude-check.sh" 2>/dev/null | cut -c1-10)" = "-r-x------" ] \
		&& [ "$(cat "$real/exclude-check.sh" 2>/dev/null)" = "${ap_exclude_script_text%$'\n'}" ]; then
		echo "Exclusion check is current: $real/exclude-check.sh"
		return 0
	fi
	tmp="$(mktemp "$real/.exclude-check.sh.XXXXXX")" || {
		echo "! Exclusion check not installed: could not create a temp file in $real." >&2
		return 0
	}
	if ! printf '%s' "$ap_exclude_script_text" >| "$tmp" || ! chmod 0500 "$tmp"; then
		rm -f -- "$tmp" 2>/dev/null || true
		echo "! Exclusion check not installed: could not write $tmp." >&2
		return 0
	fi
	sync 2>/dev/null || true
	mv -f -- "$tmp" "$real/exclude-check.sh"
	if [ "$(cat "$real/exclude-check.sh" 2>/dev/null)" != "${ap_exclude_script_text%$'\n'}" ]; then
		rm -f -- "$real/exclude-check.sh" 2>/dev/null || true
		echo "! Exclusion check not installed: what was written to $real/exclude-check.sh could not be verified; run this again." >&2
		return 0
	fi
	echo "Exclusion check installed: $real/exclude-check.sh"
}

ap_hook_cmd() {
	# $1=base $2=direct(0/1) $3=agent $4=event
	local base="$1" direct="$2" agent="$3" event="$4"
	local marker="" call_with_header call_without_header send
	ap_load_hook_pieces
	if [ "$agent" = "codex_cli" ]; then
		marker="$ap_marker_piece"
	fi
	call_with_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' -H "@$f" --data-binary "@$t"'
	call_without_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' --data-binary "@$t"'
	if [ "$direct" = "1" ]; then
		send='f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then '"$call_with_header"'; else '"$call_without_header"'; fi'
	else
		send="$call_without_header"
	fi
	printf '%s' 't=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( trap '\''rm -f "$t"'\'' EXIT; trap '\''exit 1'\'' HUP INT TERM; '"$marker""$ap_gate_piece""$send"' ) </dev/null >/dev/null 2>&1 & exit 0'
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

# Merges AgentPulse's Codex hooks into an existing hooks.json instead of
# replacing it (src/shared/hook-command.ts mergeCodexHooksFile is the
# reference; scripts/codex-hooks-merge.test.ts holds every copy to it).
# $1 = the hooks.json path, stdin = the file ap_codex_hooks_json generated.
# A handler is AgentPulse's when its "command" contains BOTH /api/v1/hooks?event=
# and X-Agent-Type (every generated command has both); every other handler,
# event and top-level key is kept in place. Other tools' bytes are never
# altered: a number that would not come back as the same text (beyond 15
# digits, 1.0, 1E5, -0, NaN) makes the file unusable. Duplicate keys in the
# existing file keep only the last one, in every copy. Writes nothing itself.
# Exit 0: stdout is the merged file, write it. Exit 3: nothing to change.
# Exit 4: the file is unreadable or not usable JSON of the expected shape; a
# message is printed and the file must be left alone. Exit 1: $1 is a symlink
# and a write would be needed.
ap_codex_merge_hooks_json() {
	local path="$1" ours py out rc=0
	ours="$(cat)"
	IFS= read -r -d '' py <<'AP_MERGE_PY_EOF' || true
import json, os, re, sys
mark = "/api/v1/hooks?event="
header = "X-Agent-Type"
q = chr(34)
path = sys.argv[1]
doc_ours = json.loads(sys.stdin.read())
ours = doc_ours["hooks"]
num_ok = re.compile(r"-?(?:0|[1-9][0-9]{0,14})|-?[1-9][0-9]{0,8}[.][0-9]{0,5}[1-9]|-?0[.][0-9]{0,3}[1-9]")
class Lossy(Exception):
    pass
def keep_number(tok):
    if tok == "-0" or not num_ok.fullmatch(tok):
        raise Lossy()
    return float(tok) if "." in tok else int(tok)
def bad_constant(tok):
    raise ValueError(tok)
def dump(o):
    return json.dumps(o, indent=2).replace(chr(127), chr(92) + "u007f")
def mine(h):
    return isinstance(h, dict) and isinstance(h.get("command"), str) and mark in h["command"] and header in h["command"]
def refuse(reason):
    sys.stderr.write("! Codex hooks not updated: " + path + " " + reason + ". It was left untouched. To add the AgentPulse hooks, fix or move that file and run this installer again." + chr(10))
    sys.exit(4)
raw = None
if os.path.exists(path):
    try:
        raw = open(path, "rb").read()
    except Exception:
        refuse("could not be read")
text = None
if raw is not None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        refuse("is not valid JSON")
if text is None or text.strip() == "":
    sys.stdout.write(dump(doc_ours) + chr(10))
    sys.exit(0)
try:
    json.loads(text, parse_constant=bad_constant)
except (ValueError, RecursionError):
    refuse("is not valid JSON")
try:
    doc = json.loads(text, parse_int=keep_number, parse_float=keep_number)
except Lossy:
    refuse("has a number that cannot be kept exactly as written")
if not isinstance(doc, dict):
    refuse("is not a JSON object")
if "hooks" in doc and not isinstance(doc["hooks"], dict):
    refuse("has a " + q + "hooks" + q + " entry that is not an object")
before = dump(doc)
hooks = dict(doc["hooks"]) if "hooks" in doc else {}
for event in ours:
    if event in hooks and not isinstance(hooks[event], list):
        refuse("has a non-list " + q + event + q + " entry")
for event in list(hooks):
    groups = hooks[event]
    if not isinstance(groups, list):
        continue
    kept = []
    slot = -1
    for g in groups:
        hs = g.get("hooks") if isinstance(g, dict) else None
        if not isinstance(hs, list) or not any(mine(h) for h in hs):
            kept.append(g)
            continue
        if slot == -1:
            slot = len(kept)
        rest = [h for h in hs if not mine(h)]
        if rest:
            g2 = dict(g)
            g2["hooks"] = rest
            kept.append(g2)
    pos = len(kept) if slot == -1 else slot
    kept[pos:pos] = ours.get(event, [])
    if kept or slot == -1:
        hooks[event] = kept
    else:
        del hooks[event]
for event in ours:
    if event not in hooks:
        hooks[event] = ours[event]
doc["hooks"] = hooks
after = dump(doc)
if after == before:
    sys.exit(3)
sys.stdout.write(after + chr(10))
AP_MERGE_PY_EOF
	if [ -L "$path" ]; then
		out="$(printf '%s\n' "$ours" | python3 -c "$py" "$path" 2>/dev/null)" || rc=$?
		if [ "$rc" = "3" ]; then return 3; fi
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	printf '%s\n' "$ours" | python3 -c "$py" "$path"
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
#
# AGEN-21 (xander, High): same predictable-tmp-name fix as
# ap_write_private_no_follow above — mktemp's XXXXXX is unguessable and
# atomic (O_CREAT|O_EXCL), closing the pre-planted-symlink attack the old
# `tmp="${path}.$$.tmp"` was open to. See that function's comment for the
# full rationale; not repeated here.
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
	if command -v mktemp >/dev/null 2>&1; then
		tmp="$(mktemp "${dir}/.$(basename -- "$path").XXXXXX")" || {
			echo "refusing: could not create a temp file in $dir" >&2
			return 1
		}
	else
		tmp="${dir}/.$(basename -- "$path").$$.${RANDOM}${RANDOM}.tmp"
		if ! ( umask 022 && set -C && : > "$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a temp file: $tmp" >&2
			return 1
		fi
	fi
	if [ -L "$tmp" ]; then
		echo "refusing to write through a symlink: $tmp" >&2
		return 1
	fi
	if ! ( set -C && cat >| "$tmp" ); then
		echo "refusing: could not write temp file: $tmp" >&2
		rm -f -- "$tmp" 2>/dev/null || true
		return 1
	fi
	chmod 0644 "$tmp"
	mv -f -- "$tmp" "$path"
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

# >>> agentpulse-bun
# Shared by scripts/setup-relay.sh and scripts/install-local.sh: the pinned Bun
# release, how a Bun on this machine is judged, and how the pinned one is
# fetched. Byte-identical in both scripts and in the copies the server serves
# (scripts/installer-shared-blocks.test.ts checks it); change all or none.
# Rules for this block: every function ends in an explicit `return`, a
# predicate is used only inside `if` or with `||`, nothing expands a whole
# array, no substitution puts `&` in a pattern-replacement (bash 5.2 reads it
# as the matched text), no exit handler is installed, and nothing is printed on
# success. Failures print a ✗ line on stderr. AP_REASON carries why the last
# path check refused.

BUN_VERSION="1.3.12"
BUN_MIN_VERSION="$BUN_VERSION"

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

# The pinned release asset for this machine, or nothing when there is none.
# $1 is where CPU flags are read on Linux (an argument, so a test can point it
# at a file).
ap_bun_asset() {
  local cpuinfo="${1:-/proc/cpuinfo}" s m rosetta="no" avx2="no" musl="no" ldd_out
  s="$(uname -s)"
  m="$(uname -m)"
  if [[ "$s" == "Darwin" ]]; then
    if [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" == "1" ]]; then rosetta="yes"; fi
    if [[ "$(sysctl -n hw.optional.avx2_0 2>/dev/null)" == "1" ]]; then avx2="yes"; fi
  elif [[ "$s" == "Linux" ]]; then
    if grep -qm1 avx2 "$cpuinfo" 2>/dev/null; then avx2="yes"; fi
    # musl's ldd prints its version and exits 1, which pipefail would turn into "not musl".
    if command -v ldd >/dev/null 2>&1; then
      ldd_out="$(ldd --version 2>&1 || true)"
      if grep -qi musl <<<"$ldd_out"; then musl="yes"; fi
    fi
  fi
  bun_asset_for "$s" "$m" "$avx2" "$musl" "$rosetta"
  return 0
}

# Whether $1 is a path a service file can hold. Sets AP_REASON when it isn't.
# Absolute; no empty, "." or ".." component and no trailing "/"; and only
# A-Za-z0-9 / . _ + - @. With "wide" as $2 (the relay, whose service files
# quote their paths) a space and valid UTF-8 are allowed too. The byte ranges
# are listed under LC_ALL=C so the result doesn't depend on the locale.
ap_safe_path() {
  local p="$1" wide="${2:-}" rest high
  AP_REASON=""
  case "$p" in
    /*) ;;
    *) AP_REASON="its path isn't absolute"; return 1 ;;
  esac
  case "$p" in
    *//*|*/./*|*/../*|*/.|*/..|*/)
      AP_REASON="its path has an empty, . or .. component"; return 1 ;;
  esac
  rest="$(printf '%s#' "$p" | LC_ALL=C tr -d 'A-Za-z0-9/._+@-')"
  if [[ "$wide" == "wide" ]]; then rest="$(printf '%s' "$rest" | LC_ALL=C tr -d ' \200-\377')"; fi
  if [[ "$rest" != "#" ]]; then
    AP_REASON="its path has characters a service file can't hold"; return 1
  fi
  if [[ "$wide" == "wide" ]]; then
    high="$(printf '%s' "$p" | LC_ALL=C tr -cd '\200-\377')"
    if [[ -n "$high" ]]; then
      if ! command -v iconv >/dev/null 2>&1; then
        AP_REASON="its path has non-ASCII characters, and iconv isn't installed to check them"; return 1
      fi
      if ! printf '%s' "$p" | LC_ALL=C iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
        AP_REASON="its path isn't valid UTF-8"; return 1
      fi
      if printf '%s' "$p" | LC_ALL=C grep -q "$(printf '\302[\200-\237]')"; then
        AP_REASON="its path has control characters"; return 1
      fi
    fi
  fi
  return 0
}

# Whether the file or directory $1 (a symlink is judged by its target) belongs
# to you or root and can't be changed by anyone else. The one group-write
# allowance is Darwin's `admin` group (gid 80), which owns Homebrew's bin and
# whose members can already become root. Sets AP_REASON when it refuses.
ap_owner_ok() {
  local mode uid gid
  AP_REASON="it or its directory isn't owned by you or root"
  read -r mode _ uid gid _ <<<"$(ls -ldnL "$1" 2>/dev/null)" || return 1
  if [[ "${mode:8:1}" == "w" ]]; then
    AP_REASON="it or its directory is writable by everyone"; return 1
  fi
  if [[ "$uid" != "$(id -u)" && "$uid" != "0" ]]; then return 1; fi
  if [[ "${mode:5:1}" == "w" ]]; then
    if [[ "$(uname -s)" != "Darwin" || "$gid" != "80" ]]; then
      AP_REASON="it or its directory is writable by its group"; return 1
    fi
  fi
  AP_REASON=""
  return 0
}

# Removes group and other write from the directory $1 when it exists and is
# owned by the current user; a directory owned by anyone else is left alone, and
# a mode is never widened. Directories AgentPulse itself made under a umask of
# 002 (the default for Fedora and Debian user-private-group accounts) are 775,
# which ap_owner_ok would then refuse.
ap_tighten_dir() {
  local mode uid
  if [[ ! -d "$1" ]]; then return 0; fi
  read -r mode _ uid _ <<<"$(ls -ldnL "$1" 2>/dev/null)" || return 0
  if [[ "$uid" == "$(id -u)" && ( "${mode:5:1}" == "w" || "${mode:8:1}" == "w" ) ]]; then
    chmod go-w "$1" 2>/dev/null || true
  fi
  return 0
}

# The one place the Bun a user already has under BUN_INSTALL (or ~/.bun) is derived.
ap_bun_install_candidate() {
  local base="${BUN_INSTALL:-${HOME%/}/.bun}"
  echo "${base%/}/bin/bun"
  return 0
}

# Whether the Bun at $1 may run in a service: a safe path, an executable file
# (a symlink is followed), owned and unwritable by others, itself and its
# directory as written, and at least BUN_MIN_VERSION. Sets AP_REASON, prints
# nothing. "wide" as $2 is passed to ap_safe_path.
ap_bun_acceptable() {
  local p="$1" v
  ap_safe_path "$p" "${2:-}" || return 1
  if [[ ! -f "$p" || ! -x "$p" ]]; then AP_REASON="isn't an executable file"; return 1; fi
  ap_owner_ok "$p" || return 1
  ap_owner_ok "$(dirname "$p")" || return 1
  v="$("$p" --version </dev/null 2>/dev/null | head -n 1 || true)"
  if ! version_at_least "$v" "$BUN_MIN_VERSION"; then
    AP_REASON="Bun ${v:-of unknown version} is older than $BUN_MIN_VERSION"; return 1
  fi
  return 0
}

# Chooses the Bun to run: the BUN_INSTALL-or-~/.bun one, then the one on PATH,
# then $1/bin/bun; the first that ap_bun_acceptable takes wins (symlinks stay as
# written, so a Homebrew path survives an upgrade). Sets BUN_BIN and BUN_DIR.
# When none qualifies, BUN_BIN is $1/bin/bun and BUN_NEEDS_INSTALL is 1. A
# candidate that exists but is refused is reported on stdout. "wide" as $2.
ap_resolve_bun() {
  local install_dir="$1" wide="${2:-}" seen=" " cand
  BUN_NEEDS_INSTALL=0
  for cand in "$(ap_bun_install_candidate)" "$(command -v bun 2>/dev/null || true)" "$install_dir/bin/bun"; do
    if [[ -z "$cand" ]]; then continue; fi
    case "$seen" in *" $cand "*) continue ;; esac
    seen="$seen$cand "
    if ap_bun_acceptable "$cand" "$wide"; then
      BUN_BIN="$cand"
      BUN_DIR="$(dirname "$cand")"
      return 0
    fi
    if [[ -e "$cand" || -L "$cand" ]]; then
      printf '  ! Not using %q: %s\n' "$cand" "$AP_REASON"
    fi
  done
  BUN_BIN="$install_dir/bin/bun"
  BUN_DIR="$install_dir/bin"
  BUN_NEEDS_INSTALL=1
  return 0
}

# The tools downloading the pinned Bun needs and this machine lacks, as words:
# unzip, and sha256sum when neither it nor shasum is present.
ap_missing_bun_tools() {
  local out=""
  if ! command -v unzip >/dev/null 2>&1; then out="unzip"; fi
  if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
    out="${out:+$out }sha256sum"
  fi
  echo "$out"
  return 0
}

# Prints a ✗ line for each tool ap_missing_bun_tools names and returns 1; returns 0 when none is missing.
ap_require_bun_tools() {
  local missing t hint
  missing="$(ap_missing_bun_tools)"
  if [[ -z "$missing" ]]; then return 0; fi
  for t in $missing; do
    hint="$(ap_install_hint "$t")"
    if [[ -n "$hint" ]]; then
      echo "  ✗ $t is required to install Bun. Install it with: $hint" >&2
    else
      echo "  ✗ $t is required to install Bun. Install it with your system's package manager." >&2
    fi
  done
  return 1
}

# Before installing Bun at $1: the path must be safe ($2 "wide" as above) and
# the nearest directory that already exists above it must be ours and
# unwritable by others. Prints the reason on stderr when it refuses.
ap_check_bun_target() {
  local p="$1" d
  if ! ap_safe_path "$p" "${2:-}"; then
    printf "  ✗ Can't install Bun at %q: %s. Install Bun 1.3.12 or newer yourself and set BUN_INSTALL to where it is.\n" "$p" "$AP_REASON" >&2
    return 1
  fi
  d="$(dirname "$p")"
  while [[ ! -d "$d" && "$d" != "/" ]]; do d="$(dirname "$d")"; done
  if ap_owner_ok "$d"; then return 0; fi
  printf "  ✗ Can't install Bun at %q: %s. Run chmod go-w on %q if you own it, or install Bun 1.3.12 or newer yourself and set BUN_INSTALL to where it is.\n" "$p" "$AP_REASON" "$d" >&2
  return 1
}

# Downloads the Bun release zip, checks its SHA256, and installs the binary at
# $4. Args: url, sha256, asset, dest_bin, work_dir (made here, mode 700), proto
# (the only scheme curl may use, also for redirects). The binary is staged next
# to its destination and renamed into place. <dir> and <dir>/bin are created at
# 755 whatever the umask; ones that already exist only lose group/other write,
# so a deliberate 700 stays 700. Prints a ✗ line on stderr and returns 1 on failure.
ap_fetch_bun_zip() {
  local url="$1" want="$2" asset="$3" dest="$4" work="$5" proto="$6"
  local got member dest_dir stage d
  ap_require_bun_tools || return 1
  if ! mkdir -p "$work" || ! chmod 700 "$work"; then
    printf "  ✗ couldn't create a temporary directory under %q\n" "$(dirname "$work")" >&2
    return 1
  fi
  rm -rf "${work:?}/x" "${work:?}/bun.zip"
  if ! curl -q --proto "=$proto" --proto-redir "=$proto" -fsSL "$url" -o "$work/bun.zip" </dev/null; then
    echo "  ✗ couldn't download Bun from $url" >&2
    return 1
  fi
  # Hashed here rather than with `-c`: macOS's BSD sha256sum rejects GNU's
  # --quiet, which made a good download look like a mismatch.
  if command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$work/bun.zip" | awk '{print $1}')"
  else
    got="$(sha256sum "$work/bun.zip" | awk '{print $1}')"
  fi
  if [[ -z "$want" || "$got" != "$want" ]]; then
    echo "  ✗ the downloaded Bun release's checksum doesn't match the pinned one; not installing it" >&2
    return 1
  fi
  if ! unzip -q "$work/bun.zip" "bun-$asset/bun" -d "$work/x" </dev/null; then
    echo "  ✗ couldn't unzip the downloaded Bun release" >&2
    return 1
  fi
  member="$work/x/bun-$asset/bun"
  if [[ ! -f "$member" || -L "$member" ]]; then
    echo "  ✗ the Bun release didn't contain a regular file at bun-$asset/bun" >&2
    return 1
  fi
  dest_dir="$(dirname "$dest")"
  for d in "$(dirname "$dest_dir")" "$dest_dir"; do
    if [[ -d "$d" ]]; then
      ap_tighten_dir "$d"
    elif ! mkdir -p "$d" || ! chmod 755 "$d"; then
      printf "  ✗ couldn't create a temporary directory under %q\n" "$(dirname "$d")" >&2
      return 1
    fi
  done
  if ! stage="$(mktemp "$dest_dir/.bun.XXXXXX")"; then
    printf "  ✗ couldn't create a temporary directory under %q\n" "$dest_dir" >&2
    return 1
  fi
  if ! cp "$member" "$stage" || ! chmod 755 "$stage" || ! mv -f "$stage" "$dest"; then
    rm -f "$stage"
    printf "  ✗ couldn't install Bun at %q\n" "$dest" >&2
    return 1
  fi
  return 0
}

# The only place the pinned URL, bun_asset_sha256 and https meet. Tests drive
# ap_fetch_bun_zip with a file:// URL instead, so production needs no override.
# Args: asset, dest_bin, work_dir.
ap_install_pinned_bun() {
  ap_fetch_bun_zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-$1.zip" "$(bun_asset_sha256 "$1")" "$1" "$2" "$3" https || return 1
  return 0
}
# <<< agentpulse-bun

# >>> agentpulse-pkg-hint
# Shared by scripts/setup-relay.sh and scripts/install-local.sh, byte-identical
# in both and in the copies the server serves; change all or none.

# The command that installs the given tools (python3, unzip, sha256sum, git…)
# with this machine's package manager, or nothing when none is found. First
# match wins: on macOS brew; elsewhere apt-get, dnf, yum, zypper, pacman, apk,
# then brew. sudo is dropped for root and never added for brew.
ap_install_hint() {
  local mgr="" m t p pkgs="" sudo=""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then mgr="brew"; fi
  else
    for m in apt-get dnf yum zypper pacman apk brew; do
      if command -v "$m" >/dev/null 2>&1; then mgr="$m"; break; fi
    done
  fi
  if [[ -z "$mgr" ]]; then return 0; fi
  if [[ "$mgr" != "brew" && "$(id -u)" != "0" ]]; then sudo="sudo "; fi
  for t in "$@"; do
    p="$t"
    case "$t" in
      python3) if [[ "$mgr" == "pacman" || "$mgr" == "brew" ]]; then p="python"; fi ;;
      sha256sum) p="coreutils" ;;
    esac
    pkgs="${pkgs:+$pkgs }$p"
  done
  case "$mgr" in
    apt-get) echo "${sudo}apt-get update && ${sudo}apt-get install -y $pkgs" ;;
    dnf) echo "${sudo}dnf install -y $pkgs" ;;
    yum) echo "${sudo}yum install -y $pkgs" ;;
    zypper) echo "${sudo}zypper install -y $pkgs" ;;
    pacman) echo "${sudo}pacman -S --needed $pkgs" ;;
    apk) echo "${sudo}apk add $pkgs" ;;
    brew) echo "brew install $pkgs" ;;
  esac
  return 0
}
# <<< agentpulse-pkg-hint

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

# ── Choose Bun, and refuse here if it can't be had ──
# L9: a machine that can't get Bun (no unzip, no checksum tool, no pinned
# release) is refused before the key prompt, not after it. systemd expands %
# and $ even inside quotes, so a HOME holding either is refused too.
if ! ap_safe_path "$RELAY_DIR" wide; then
  fail "The relay keeps its files and Bun under $(printf %q "${HOME%/}")/.agentpulse, and that path can't be used ($AP_REASON). It may hold only letters, digits, spaces, UTF-8 text and / . _ + - @. Run the installer as a user whose home path fits."
fi
# A umask of 002 leaves the directories an earlier run (or the supervisor) made group-writable.
ap_tighten_dir "$RELAY_DIR"
ap_tighten_dir "$PRIVATE_BUN_DIR"
ap_tighten_dir "$PRIVATE_BUN_DIR/bin"
ap_resolve_bun "$PRIVATE_BUN_DIR" wide
if [[ "$BUN_NEEDS_INSTALL" == 1 ]]; then
  AP_BUN_ASSET="$(ap_bun_asset)"
  [[ -n "$AP_BUN_ASSET" ]] \
    || fail "There's no pinned Bun $BUN_VERSION release for $(uname -s)/$(uname -m). Install Bun $BUN_MIN_VERSION or newer and run this installer again, or set BUN_INSTALL to where it is."
  ap_require_bun_tools || exit 1
  ap_check_bun_target "$BUN_BIN" wide || exit 1
fi

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
    fail "relay.ts isn't next to this script. Run scripts/setup-relay.sh from an AgentPulse checkout, or: curl -fsSL --proto '=https' <server>/setup-relay.sh | bash (set \$AGENTPULSE_KEY first, or you'll be prompted for the key)"
  fi
fi

# ── Install Bun ──
# F190: the relay keeps its state files private (0600) through appendFile's
# `mode`, which Bun 1.1.30 ignores (F171). So the service only ever runs a Bun
# at or above the floor, chosen above: ~/.bun's (or $BUN_INSTALL's), the one on
# PATH, or a private copy of the pinned release in ~/.agentpulse/bun, which is
# installed here when none qualified, without touching the user's own Bun or
# shell profile.

if [[ "$BUN_NEEDS_INSTALL" == 1 ]]; then
  # On a first run ~/.agentpulse doesn't exist yet. Made by the installer's mkdir -p
  # under a umask of 002 it would be 775 until the chmod below, with Bun already in
  # it, so it is made private before anything is fetched. Here and not with the
  # checks above, so a run refused for its key writes nothing.
  (umask 077 && mkdir -p "$RELAY_DIR") || fail "couldn't create $(printf %q "$RELAY_DIR")"
  if [[ -O "$RELAY_DIR" ]]; then chmod go-rwx "$RELAY_DIR" 2>/dev/null || true; fi
  echo "  Installing Bun $BUN_VERSION for the relay into $PRIVATE_BUN_DIR..."
  ap_install_pinned_bun "$AP_BUN_ASSET" "$BUN_BIN" "$SRC_DIR/bun" || exit 1
  if ! ap_bun_acceptable "$BUN_BIN" wide; then
    rm -f "$BUN_BIN"
    fail "the Bun just installed at $(printf %q "$BUN_BIN") isn't usable ($AP_REASON)"
  fi
fi
BUN_PATH="$BUN_BIN"
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
# A symlinked settings.json (a dotfiles repo, say) is written through: the file
# it points at is replaced and the link is left as it was.
path = os.path.realpath(os.environ["AP_SETTINGS"])
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
# A symlinked settings.json (a dotfiles repo, say) is written through, so the
# merge below replaces the file the link points at and leaves the link alone.
if [[ -L "$CLAUDE_SETTINGS" ]]; then
  CLAUDE_SETTINGS="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$CLAUDE_SETTINGS")"
fi

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

HOOKS_JSON="{"
for i in "${!EVENTS[@]}"; do
  EVENT="${EVENTS[$i]}"
  [[ $i -gt 0 ]] && HOOKS_JSON+=","
  HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"http://localhost:${PORT}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_SKIP\"],\"headers\":{\"X-Agent-Type\":\"claude_code\",\"X-AgentPulse-Skip\":\"\$AGENTPULSE_SKIP\"}}]}]"
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

# Set when Codex hooks were really (re)written, so the closing line can ask the
# user to approve them again.
CODEX_HOOKS_WRITTEN="0"
ap_install_exclude_script
NEW_CODEX_HOOKS_JSON="$(ap_codex_hooks_json "http://localhost:${PORT}" "0")"
CODEX_MERGE_RC=0
MERGED_CODEX_HOOKS_JSON="$(printf '%s\n' "$NEW_CODEX_HOOKS_JSON" | ap_codex_merge_hooks_json "$CODEX_DIR/hooks.json")" || CODEX_MERGE_RC=$?
if [[ "$CODEX_MERGE_RC" == "3" ]]; then
  echo "  ✓ Codex hooks unchanged — no re-trust needed"
elif [[ "$CODEX_MERGE_RC" == "4" ]]; then
  : # ap_codex_merge_hooks_json already said why; the file is left as it was
elif [[ "$CODEX_MERGE_RC" != "0" ]]; then
  exit 1
else
  if [[ -f "$CODEX_DIR/hooks.json" ]]; then
    CODEX_HOOKS_WRITTEN="updated"
    CODEX_BACKUP_FILE="$CODEX_DIR/hooks.json.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cat "$CODEX_DIR/hooks.json" | ap_write_no_follow "$CODEX_BACKUP_FILE" || exit 1
    echo "  ✓ Backed up existing Codex hooks to $CODEX_BACKUP_FILE"
  fi
  printf '%s\n' "$MERGED_CODEX_HOOKS_JSON" | ap_write_no_follow "$CODEX_DIR/hooks.json" || exit 1
  echo "  ✓ Codex CLI hooks → localhost:$PORT"
  echo "    Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
  echo "    Re-trust after changing the AgentPulse URL or port."
  [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]] || CODEX_HOOKS_WRITTEN="new"
fi
echo "    After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"
# D12: codex_hooks is a deprecated (but still-working) legacy alias for
# [features].hooks — left alone if present, never newly written.

# Copilot CLI (D8): only written when copilot is detected — never create
# config for a tool that isn't installed.
COPILOT_WRITTEN="0"
if command -v copilot >/dev/null 2>&1 || [[ -d "$HOME/.copilot" ]]; then
  COPILOT_DIR="$HOME/.copilot/hooks"
  COPILOT_HOOKS_FILE="$COPILOT_DIR/agentpulse.json"
  mkdir -p "$COPILOT_DIR"

  ap_install_exclude_script
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
if [[ "$CODEX_HOOKS_WRITTEN" == "new" ]]; then
  echo "  Codex needs you to approve these hooks: run /hooks in Codex."
elif [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]]; then
  echo "  Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more."
fi

}
