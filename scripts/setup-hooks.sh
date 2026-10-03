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
# Off by default: --statusline adds the Claude Code statusline (claude_code only).
WITH_STATUSLINE="0"
# Set when Codex hooks were really (re)written, so the closing line can ask the
# user to approve them again.
CODEX_HOOKS_WRITTEN="0"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) AGENTPULSE_URL="$2"; shift 2 ;;
    --key) AGENTPULSE_KEY="$2"; shift 2 ;;
    --agent) AGENT_TYPE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --no-auth-check) NO_AUTH_CHECK="1"; shift ;;
    --statusline) WITH_STATUSLINE="1"; shift ;;
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
      echo "  --statusline  Also install the Claude Code statusline (claude_code only;"
      echo "                off by default, never replaces an existing statusLine)"
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
# A handler is AgentPulse's when its "command" contains /api/v1/hooks?event= ;
# every other handler, event and top-level key is kept in place. Writes nothing
# itself. Exit 0: stdout is the merged file, write it. Exit 3: nothing to change.
# Exit 4: the file is not usable JSON of the expected shape; a message is
# printed and the file must be left alone. Exit 1: $1 is a symlink and a write
# would be needed.
ap_codex_merge_hooks_json() {
	local path="$1" ours py out rc=0
	ours="$(cat)"
	IFS= read -r -d '' py <<'AP_MERGE_PY_EOF' || true
import json, os, sys
mark = "/api/v1/hooks?event="
q = chr(34)
path = sys.argv[1]
doc_ours = json.loads(sys.stdin.read())
ours = doc_ours["hooks"]
def dump(o):
    return json.dumps(o, indent=2).replace(chr(127), chr(92) + "u007f")
def mine(h):
    return isinstance(h, dict) and isinstance(h.get("command"), str) and mark in h["command"]
def refuse(reason):
    sys.stderr.write("! Codex hooks not updated: " + path + " " + reason + ". It was left untouched. To add the AgentPulse hooks, fix or move that file and run this installer again." + chr(10))
    sys.exit(4)
text = None
if os.path.exists(path):
    try:
        text = open(path, "rb").read().decode("utf-8")
    except Exception:
        refuse("is not valid JSON")
if text is None or text.strip() == "":
    sys.stdout.write(dump(doc_ours) + chr(10))
    sys.exit(0)
try:
    doc = json.loads(text)
except ValueError:
    refuse("is not valid JSON")
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

# --statusline: installs statusline.sh from next to this installer as
# ~/.claude/statusline-agentpulse.sh and enables it only when settings.json
# has no statusLine yet; someone else's is never replaced.
ap_install_statusline() {
  local self_script self_dir src dest settings result
  # Only the statusline.sh that ships next to this installer on disk is ever
  # copied. Piped into bash (`curl ... | bash`), or run from process
  # substitution, there is no file and BASH_SOURCE is empty or a pipe: falling
  # back to the working directory would install whatever ./statusline.sh is
  # sitting there as an executable.
  # A shell reading its script from a pipe may still report its own name as the
  # script (bash -s says "bash"), so the file must be named setup-hooks.sh and
  # identify itself as this installer, and the shell must not have been handed
  # the text on its command line or stdin.
  self_script="${BASH_SOURCE[0]:-}"
  self_dir=""
  src=""
  # A script given as text (`bash -c "$(curl ...)" setup-hooks.sh`, or `bash -s` on stdin) has
  # a name but no file: $- carries c or s then, and the name can be anything the caller typed.
  if [[ "$-" != *[cs]* && -n "$self_script" && "${self_script##*/}" == "setup-hooks.sh" && -f "$self_script" && ! -L "$self_script" ]] \
    && grep -q '^# AgentPulse Hook Setup Script' "$self_script" 2>/dev/null; then
    self_dir="$(cd "$(dirname -- "$self_script")" 2>/dev/null && pwd -P)" || self_dir=""
    [[ -n "$self_dir" ]] && src="$self_dir/statusline.sh"
  fi
  if [[ -z "$src" || -L "$src" || ! -f "$src" ]]; then
    echo "Statusline: --statusline needs the installer to be a file on disk next to a real statusline.sh, and this run has neither (piped installs have no file). Clone the repository and run scripts/setup-hooks.sh --statusline, or use the relay installer, which includes the statusline." >&2
    return 0
  fi
  dest="$HOME/.claude/statusline-agentpulse.sh"
  settings="$HOME/.claude/settings.json"
  ap_write_no_follow "$dest" < "$src" || return 1
  chmod 755 "$dest"
  result="$(AP_SETTINGS="$settings" AP_CMD="~/.claude/statusline-agentpulse.sh" python3 -c '
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
  case "$result" in
    set) echo "Statusline installed and enabled ($dest)" ;;
    same) echo "Statusline updated ($dest)" ;;
    other) echo "Statusline installed at $dest; your settings.json already has a statusLine, so it was left alone." ;;
    *) echo "Statusline installed at $dest; settings.json could not be read as JSON, so it was left alone." ;;
  esac
  command -v jq >/dev/null 2>&1 || echo "! The statusline needs jq; install it to see session names there"
}

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
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_SKIP\"],\"headers\":{\"Authorization\":\"Bearer ${AGENTPULSE_KEY}\",\"X-Agent-Type\":\"claude_code\",\"X-AgentPulse-Skip\":\"\$AGENTPULSE_SKIP\"}}]}]"
    else
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_API_KEY\",\"AGENTPULSE_SKIP\"],\"headers\":{\"Authorization\":\"Bearer \$AGENTPULSE_API_KEY\",\"X-Agent-Type\":\"claude_code\",\"X-AgentPulse-Skip\":\"\$AGENTPULSE_SKIP\"}}]}]"
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
      # F<new> (High, xander re-verify): a plain "${SETTINGS_FILE}.tmp"
      # redirect target is predictable -- a pre-planted symlink there
      # would let this write (carrying the literal key, at global scope)
      # follow it, and the following `mv` would turn settings.json ITSELF
      # into that symlink; the trailing chmod 600 further down would then
      # narrow the attacker's file, not ours. mktemp's unpredictable
      # sibling name closes that: nothing can pre-plant a symlink at a
      # name it can't guess. The immediate -L check is defense in depth
      # against the (already vanishingly small) race between mktemp's own
      # atomic create and this check.
      TMP="$(umask 077 && mktemp "${SETTINGS_FILE}.XXXXXX")" || {
        echo "can't create a temp file for $SETTINGS_FILE" >&2
        exit 1
      }
      if [[ -L "$TMP" ]]; then
        echo "refusing to write through a symlinked temp file: $TMP" >&2
        rm -f "$TMP"
        exit 1
      fi
      EXISTING=$(cat "$SETTINGS_FILE")
      echo "$EXISTING" | jq --argjson hooks "$HOOKS_JSON" '.hooks = (.hooks // {}) * $hooks' > "$TMP"
      mv -f "$TMP" "$SETTINGS_FILE"
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
  if [[ "$WITH_STATUSLINE" == "1" ]]; then
    ap_install_statusline
  else
    echo "Statusline: re-run with --statusline to add the AgentPulse statusline to Claude Code (it shows when rules are invalid or AGENTPULSE_SKIP is set)."
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

  ap_install_exclude_script
  NEW_CODEX_HOOKS_JSON="$(ap_codex_hooks_json "$AGENTPULSE_URL" "1")"
  CODEX_MERGE_RC=0
  MERGED_CODEX_HOOKS_JSON="$(printf '%s\n' "$NEW_CODEX_HOOKS_JSON" | ap_codex_merge_hooks_json "$HOOKS_FILE")" || CODEX_MERGE_RC=$?
  if [[ "$CODEX_MERGE_RC" == "3" ]]; then
    echo "Codex hooks unchanged — no re-trust needed"
  elif [[ "$CODEX_MERGE_RC" == "4" ]]; then
    : # ap_codex_merge_hooks_json already said why; the file is left as it was
  elif [[ "$CODEX_MERGE_RC" != "0" ]]; then
    exit 1
  else
    if [[ -f "$HOOKS_FILE" ]]; then
      CODEX_HOOKS_WRITTEN="updated"
      CODEX_BACKUP_FILE="${HOOKS_FILE}.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$HOOKS_FILE" | ap_write_no_follow "$CODEX_BACKUP_FILE" || exit 1
      echo "Backed up existing $HOOKS_FILE to $CODEX_BACKUP_FILE"
    fi
    printf '%s\n' "$MERGED_CODEX_HOOKS_JSON" | ap_write_no_follow "$HOOKS_FILE" || exit 1
    echo "Codex CLI hooks configured in $HOOKS_FILE"
    echo "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Re-trust after changing the AgentPulse URL or port."
    [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]] || CODEX_HOOKS_WRITTEN="new"
  fi
  echo "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"

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

  ap_install_exclude_script
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
  echo "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"

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
if [[ "$CODEX_HOOKS_WRITTEN" == "new" ]]; then
  echo "Codex needs you to approve these hooks: run /hooks in Codex."
elif [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]]; then
  echo "Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more."
fi
