#!/usr/bin/env bash
set -euo pipefail

# AgentPulse local installer
# One-command Bun + SQLite deployment for macOS/Linux.

# One block: bash reads the whole script before running any of it, so
# `curl | bash` never runs a half-downloaded script, and an early exit doesn't
# leave curl writing into a closed pipe.
{

# A trailing slash on HOME would put "//" in every path derived from it.
while [[ "$HOME" == */ && "$HOME" != / ]]; do HOME="${HOME%/}"; done

REPO_URL="https://github.com/jstuart0/agentpulse.git"
REPO_REF="main"
AGENTPULSE_DIR="${HOME%/}/.agentpulse"
LOG_DIR="${AGENTPULSE_DIR}/logs"
INSTALL_DIR="${AGENTPULSE_DIR}/app"
INSTALL_DIR_GIVEN="false"
DATA_DIR="${AGENTPULSE_DIR}/data"
DATA_DIR_GIVEN="false"
PORT="3000"
HOST="0.0.0.0"
PUBLIC_URL=""
DISABLE_AUTH="true"
API_KEY=""
AUTO_HOOKS="true"
AUTO_SUPERVISOR="true"
SERVICE_MODE="auto"
SERVICE_NAME="agentpulse"

# An option that takes a value but has none: it is last on the line, or the next
# word is another option.
need_value() {
  if [[ $# -lt 2 || "$2" == --* ]]; then
    printf '  ✗ %s needs a value\n' "$1" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) need_value "$@"; REPO_REF="$2"; shift 2 ;;
    --repo) need_value "$@"; REPO_URL="$2"; shift 2 ;;
    --dir) need_value "$@"; INSTALL_DIR="$2"; INSTALL_DIR_GIVEN="true"; shift 2 ;;
    --data-dir) need_value "$@"; DATA_DIR="$2"; DATA_DIR_GIVEN="true"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --host) need_value "$@"; HOST="$2"; shift 2 ;;
    --public-url) need_value "$@"; PUBLIC_URL="$2"; shift 2 ;;
    --disable-auth) need_value "$@"; DISABLE_AUTH="$2"; shift 2 ;;
    --api-key) need_value "$@"; API_KEY="$2"; shift 2 ;;
    --skip-hooks) AUTO_HOOKS="false"; shift 1 ;;
    --skip-supervisor) AUTO_SUPERVISOR="false"; shift 1 ;;
    --service) need_value "$@"; SERVICE_MODE="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
AgentPulse local installer

Usage:
  curl -fsSL <script-url> | bash

Options:
  --ref <git-ref>          Git branch/tag to install (default: main)
  --repo <git-url>         Git repo to install from
  --dir <path>             Install directory (default: ~/.agentpulse/app)
  --data-dir <path>        SQLite/data directory (default: ~/.agentpulse/data)
  --port <port>            Web port (default: 3000)
  --host <host>            Bind host (default: 0.0.0.0)
  --public-url <url>       Public URL used for setup.sh output
  --disable-auth <bool>    Set DISABLE_AUTH (default: true)
  --api-key <key>          Set AGENTPULSE_INITIAL_API_KEY
  --skip-hooks             Do not auto-run setup.sh after install
  --skip-supervisor        Do not auto-install the local supervisor
  --service <mode>         auto | none | systemd | launchd
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# >>> agentpulse-private-write
# AGEN-21 (security, Medium): .env.local and supervisor.json both hold
# secrets in plaintext (AGENTPULSE_INITIAL_API_KEY, and the supervisor
# credential/enrollment token respectively) and were previously written
# with a bare `cat > path <<EOF` / python3 `open(path, "w")` — both follow
# a symlink at the destination and leave the file at the OS-default create
# mode (0644 under a typical umask), readable by any local user.
# ap_write_private_no_follow is the same no-follow, 0600 primitive already
# established in scripts/setup-hooks.sh and scripts/setup-relay.sh for
# exactly this class of file (hook-auth-header); ported here verbatim
# rather than shared, since install-local.sh has no other dependency on
# those files and stays a single self-contained installer.
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
  mkdir -p "$dir"
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
# <<< agentpulse-private-write
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

# The Bun release asset for this machine. Args: os (`uname -s`), arch
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
# yourself rather than trusting the file alone.
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
  # With "ancestor" as $2 a sticky directory (/tmp, mode 1777) is let through when root or
  # you own it: others can add to it but not rename or remove what is yours.
  if [[ "${2:-}" == "ancestor" && "${mode:9:1}" == [tT] && ( "$uid" == "$(id -u)" || "$uid" == "0" ) ]]; then
    AP_REASON=""
    return 0
  fi
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

# Removes group and other write from the directory $1 when it exists, is not a
# symbolic link (chmod would follow it) and is owned by the current user; a directory owned by anyone else is left alone, and
# a mode is never widened. Directories AgentPulse itself made under a umask of
# 002 (the default for Fedora and Debian user-private-group accounts) are 775,
# which ap_owner_ok would then refuse.
ap_tighten_dir() {
  local mode uid
  if [[ ! -d "$1" || -L "$1" ]]; then return 0; fi
  read -r mode _ uid _ <<<"$(ls -ldn "$1" 2>/dev/null)" || return 0
  if [[ "$uid" == "$(id -u)" && ( "${mode:5:1}" == "w" || "${mode:8:1}" == "w" ) ]]; then
    chmod go-w "$1" 2>/dev/null || true
  fi
  return 0
}

# Prints a ✗ line and returns 1 for the first directory given that is a symbolic link:
# they are chmod'ed and written into, so they have to be real directories.
ap_refuse_linked_dirs() {
  local d
  for d in "$@"; do
    if [[ -L "$d" ]]; then
      printf '  ✗ %q is a symbolic link; it must be a real directory. Nothing was installed.\n' "$d" >&2
      return 1
    fi
  done
  return 0
}

# Whether the directory $1 and every directory above it up to / may be trusted: $1 itself
# by ap_owner_ok, the ones above it by the same rule except that a sticky directory like /tmp
# passes. Sets AP_REASON.
ap_bun_dir_chain_ok() {
  local d="$1"
  AP_REASON="its symbolic link goes through a directory that is writable by others or isn't owned by you or root"
  if ! ap_owner_ok "$d"; then
    AP_REASON="its symbolic link goes through a directory that is writable by others or isn't owned by you or root"
    return 1
  fi
  while [[ "$d" != "/" ]]; do
    d="$(dirname "$d")"
    if ! ap_owner_ok "$d" ancestor; then
      AP_REASON="its symbolic link goes through a directory that is writable by others or isn't owned by you or root"
      return 1
    fi
  done
  AP_REASON=""
  return 0
}

# Whether the symbolic link $1 leads somewhere that can be trusted: the directory of every
# link in the chain (at most 40) and of the final target, each with everything above it up to
# / (ap_bun_dir_chain_ok). The target file itself is judged by the caller. Sets AP_REASON.
ap_bun_link_ok() {
  local p="$1" hops=0 d t
  while [[ -L "$p" ]]; do
    if [[ "$hops" -ge 40 ]]; then AP_REASON="it is a chain of more than 40 symbolic links"; return 1; fi
    hops=$((hops + 1))
    d="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    ap_bun_dir_chain_ok "$d" || return 1
    t="$(readlink "$p")" || return 1
    case "$t" in
      /*) p="$t" ;;
      *) p="$d/$t" ;;
    esac
  done
  d="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  ap_bun_dir_chain_ok "$d" || return 1
  AP_REASON=""
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
# directory as written, for a symbolic link also everything ap_bun_link_ok
# checks, and at least BUN_MIN_VERSION. Sets AP_REASON, prints
# nothing. "wide" as $2 is passed to ap_safe_path.
ap_bun_acceptable() {
  local p="$1" v
  ap_safe_path "$p" "${2:-}" || return 1
  if [[ ! -f "$p" || ! -x "$p" ]]; then AP_REASON="isn't an executable file"; return 1; fi
  ap_owner_ok "$p" || return 1
  ap_owner_ok "$(dirname "$p")" || return 1
  if [[ -L "$p" ]]; then ap_bun_link_ok "$p" || return 1; fi
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
      printf "  ✗ couldn't create the directory %q for Bun\n" "$d" >&2
      return 1
    fi
  done
  if ! stage="$(mktemp "$dest_dir/.bun.XXXXXX")"; then
    printf "  ✗ couldn't create a temporary file in %q\n" "$dest_dir" >&2
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

# >>> agentpulse-local-prereqs
# What this installer checks before it writes anything: its arguments, its
# paths, the service directory, which Bun it will use and whether it can get
# one, and the tools it needs. Each check prints a ✗ line on stderr and stops
# the run; none of them writes a file.

# Prints the ✗ line for a bad option value and stops.
ap_local_arg_bad() {
  printf '  ✗ %s %s\n' "$1" "$2" >&2
  exit 1
}

# The text of $1 without control characters (C0 and DEL), byte by byte.
ap_local_strip_controls() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177'
  return 0
}

# Whether $1 is a host to bind: letters, digits, '.', ':', '_' and '-', or an IPv6
# address in brackets.
ap_local_host_ok() {
  local h="$1"
  case "$h" in
    '') return 1 ;;
    \[*\]) h="${h#[}"; h="${h%]}"
      case "$h" in ''|*[!0-9A-Fa-f:.]*) return 1 ;; esac
      return 0 ;;
    *[!A-Za-z0-9.:_-]*) return 1 ;;
  esac
  return 0
}

ap_local_validate_args() {
  local digits repo_reason repo_name repo_path repo_ssh repo_scp repo_port
  case "$PORT" in
    ''|*[!0-9]*) ap_local_arg_bad --port "must be a number from 1 to 65535" ;;
  esac
  digits=${#PORT}
  if [[ "$digits" -gt 5 ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
    ap_local_arg_bad --port "must be a number from 1 to 65535"
  fi
  case "$DISABLE_AUTH" in
    true|false) ;;
    *) ap_local_arg_bad --disable-auth "must be true or false" ;;
  esac
  case "$API_KEY" in
    *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*)
      ap_local_arg_bad --api-key "can only contain letters, digits, '.', '_' and '-'" ;;
  esac
  ap_local_host_ok "$HOST" || ap_local_arg_bad --host "can only contain letters, digits, '.', ':', '_' and '-', or an IPv6 address in [brackets]"
  case "$REPO_REF" in
    -*|*..*|''|*[!A-Za-z0-9._/-]*)
      ap_local_arg_bad --ref "can only contain letters, digits, '.', '_', '/' and '-', can't start with '-' and can't contain '..'" ;;
  esac
  # https://, ssh://[user@]host[:port]/path, user@host:path, or a local absolute path. A first
  # character other than a letter or digit, and every transport:: form, is refused by the patterns.
  repo_reason="must be an https:// URL (without spaces, quotes, $, ; or <>), an ssh:// URL, a user@host:path address or an absolute path of letters, digits and / . _ + - @"
  repo_name='[A-Za-z0-9][A-Za-z0-9._-]*'
  repo_path='[A-Za-z0-9._/~-]'
  repo_ssh="^ssh://(${repo_name}@)?${repo_name}(:[0-9]{1,5})?/${repo_path}+\$"
  repo_scp="^${repo_name}@${repo_name}:[A-Za-z0-9._/~]${repo_path}*\$"
  case "$REPO_URL" in
    https://*)
      # A token in the URL would be kept in .git/config (readable by others) and show in git's command line.
      AP_AUTH="${REPO_URL#https://}"
      AP_AUTH="${AP_AUTH%%[/?#]*}"
      if [[ "${AP_AUTH}" == *@* ]]; then
        ap_local_arg_bad --repo "can't contain a user name or token; use a git credential helper"
      fi
      # The same URL characters as --public-url (no quote, $ or ;); \133 and \135 are [ and ].
      # (A newline would vanish from the remainder below, as command substitution drops it.)
      if [[ "$(ap_local_strip_controls "$REPO_URL")" != "$REPO_URL" ]] || [[ -n "$(printf '%s' "$REPO_URL" | LC_ALL=C tr -d 'A-Za-z0-9._~:/?#\133\135@!&()*+,=%-')" ]]; then
        ap_local_arg_bad --repo "$repo_reason"
      fi ;;
    ssh://*)
      [[ "$REPO_URL" =~ $repo_ssh ]] || ap_local_arg_bad --repo "$repo_reason"
      repo_port="${BASH_REMATCH[2]#:}"
      if [[ -n "$repo_port" ]] && (( 10#$repo_port < 1 || 10#$repo_port > 65535 )); then
        ap_local_arg_bad --repo "$repo_reason"
      fi ;;
    /*)
      ap_safe_path "$REPO_URL" || ap_local_arg_bad --repo "$repo_reason" ;;
    *)
      [[ "$REPO_URL" =~ $repo_scp ]] || ap_local_arg_bad --repo "$repo_reason" ;;
  esac
  if [[ "$(ap_local_strip_controls "$PUBLIC_URL")" != "$PUBLIC_URL" ]]; then
    ap_local_arg_bad --public-url "can't contain control characters"
  fi
  if [[ -n "$PUBLIC_URL" ]]; then
    case "$PUBLIC_URL" in
      http://*|https://*) ;;
      *) ap_local_arg_bad --public-url "must be an http:// or https:// URL without spaces, quotes, $, ; or <>" ;;
    esac
    # \133 and \135 are [ and ]; written as escapes so tr reads no range or class. A quote starts
    # a quoted value in systemd's EnvironmentFile, and Bun expands $ in a .env value, so neither
    # (nor ;, out of caution) is allowed.
    if [[ -n "$(printf '%s' "$PUBLIC_URL" | LC_ALL=C tr -d 'A-Za-z0-9._~:/?#\133\135@!&()*+,=%-')" ]]; then
      ap_local_arg_bad --public-url "must be an http:// or https:// URL without spaces, quotes, $, ; or <>"
    fi
  fi
  return 0
}

# Prints the ✗ line for path $2 (named $1 in the message) and returns 1 unless
# it is a path the unit files and .env.local can hold.
ap_local_path_ok() {
  local what="$1" p="$2" reason
  if [[ -z "$p" ]]; then
    reason="it's empty"
  elif ! ap_safe_path "$p"; then
    reason="it ${AP_REASON#its path }"
  else
    return 0
  fi
  printf "  ✗ %s %q can't be used: %s. Use an absolute path of letters, digits and / . _ + - @.\n" "$what" "$p" "$reason" >&2
  return 1
}

# One trailing "/" is dropped, then --dir, --data-dir and the log directory are
# checked, in that order.
ap_local_check_paths() {
  if [[ ${#INSTALL_DIR} -gt 1 && "$INSTALL_DIR" == */ ]]; then INSTALL_DIR="${INSTALL_DIR%/}"; fi
  if [[ ${#DATA_DIR} -gt 1 && "$DATA_DIR" == */ ]]; then DATA_DIR="${DATA_DIR%/}"; fi
  if [[ ${#LOG_DIR} -gt 1 && "$LOG_DIR" == */ ]]; then LOG_DIR="${LOG_DIR%/}"; fi
  ap_local_path_ok "--dir" "$INSTALL_DIR" || return 1
  ap_local_path_ok "--data-dir" "$DATA_DIR" || return 1
  ap_local_path_ok "the log directory" "$LOG_DIR" || return 1
  ap_local_dir_holds "$INSTALL_DIR" "$HOME" "your home directory" || return 1
  ap_local_dir_holds "$INSTALL_DIR" "$AGENTPULSE_DIR" "the AgentPulse directory" || return 1
  ap_local_dir_holds "$INSTALL_DIR" "$DATA_DIR" "--data-dir" || return 1
  ap_local_dir_holds "$INSTALL_DIR" "$LOG_DIR" "the log directory" || return 1
  return 0
}

# Refuses, with the would-hold line, a --dir ($1) that is, or contains, the path $2
# (named $3): the installer deletes --dir when it isn't a git checkout. Compared by
# name and with every symbolic link resolved.
ap_local_dir_holds() {
  local dir="$1" other="$2" what="$3" dirp otherp
  dirp="$(ap_local_physical "$dir")"
  otherp="$(ap_local_physical "$other")"
  case "$other/" in "$dir/"*) ;; *)
    case "$otherp/" in "$dirp/"*) ;; *) return 0 ;; esac ;;
  esac
  printf "  ✗ --dir %q would hold or replace %s %q, and the installer deletes --dir when it isn't a git checkout. Choose another --dir.\n" "$dir" "$what" "$other" >&2
  return 1
}

# Resolves --service auto, refuses a mode this installer doesn't have, and
# refuses a service directory that is itself a symbolic link.
ap_local_preflight_services() {
  local unit_dir="" files="" f
  if [[ "${SERVICE_MODE}" == "auto" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
      SERVICE_MODE="launchd"
    elif need_cmd systemctl; then
      SERVICE_MODE="systemd"
    else
      SERVICE_MODE="none"
    fi
  fi
  case "${SERVICE_MODE}" in
    systemd) unit_dir="${HOME}/.config/systemd/user" ;;
    launchd) unit_dir="${HOME}/Library/LaunchAgents" ;;
    none) ;;
    *)
      echo "Error: unsupported --service mode '${SERVICE_MODE}'" >&2
      return 1
      ;;
  esac
  if [[ -n "$unit_dir" && -L "$unit_dir" ]]; then
    printf "  ✗ %q is a symbolic link; the installer won't write service files through it. Nothing was installed.\n" "$unit_dir" >&2
    return 1
  fi
  # The service files themselves, too: finding that out at the write would be after the clone and build.
  case "${SERVICE_MODE}" in
    systemd) files="${unit_dir}/${SERVICE_NAME}.service" ;;
    launchd) files="${unit_dir}/dev.agentpulse.local.plist" ;;
  esac
  if [[ "${AUTO_SUPERVISOR}" == "true" ]]; then
    case "${SERVICE_MODE}" in
      systemd) files="${files} ${unit_dir}/${SERVICE_NAME}-supervisor.service" ;;
      launchd) files="${files} ${unit_dir}/dev.agentpulse.supervisor.plist" ;;
    esac
  fi
  for f in $files; do
    if [[ -L "$f" ]]; then
      printf "  ✗ %q is a symbolic link; the installer won't write service files through it. Nothing was installed.\n" "$f" >&2
      return 1
    fi
  done
  return 0
}

# The installer replaces --dir with a fresh clone when it isn't a git checkout. Refuse
# (before anything is written) unless there is nothing there to lose: it doesn't exist,
# is an empty directory, or is an older copy of AgentPulse itself (its top-level
# package.json is named agentpulse).
ap_local_check_install_dir() {
  local d="${INSTALL_DIR}"
  if [[ ! -e "$d" && ! -L "$d" ]]; then return 0; fi
  # A git checkout (a link to one included) is updated in place, never deleted. git runs
  # in it with your hooks and config, so it and its .git (a directory or a gitfile) must be yours.
  if [[ -d "$d/.git" || -f "$d/.git" ]]; then
    if ap_local_owned_by_me "$d" "$d/.git"; then
      # In the default checkout the files git reads (config, hooks) must be yours too.
      if [[ "${INSTALL_DIR_GIVEN}" == "true" ]] || ap_local_tree_owned_by_me "$d"; then return 0; fi
    fi
    printf "  ✗ %q is owned by another user; the installer won't run git in it. Move it or choose another --dir.\n" "$d" >&2
    return 1
  fi
  if [[ -d "$d" && ! -L "$d" ]]; then
    if [[ -z "$(ls -A "$d" 2>/dev/null)" ]]; then return 0; fi
    if ap_local_is_agentpulse_package "$d/package.json"; then return 0; fi
  fi
  printf "  ✗ --dir %q already exists and isn't an AgentPulse checkout; the installer won't delete it. Move it or choose another --dir.\n" "$d" >&2
  return 1
}

# Whether nothing under the directory $1 (links are not followed) belongs to another user.
# A tree that can't be read through counts as not owned.
ap_local_tree_owned_by_me() {
  local other
  other="$(find "$1" ! -uid "$(id -u)" -print -quit 2>/dev/null)" || return 1
  [[ -z "$other" ]]
}

# Removes group and other write from everything in the checkout $1 (a directory, not a link),
# without following links: find lists only what is not a link, and chmod gets those paths.
ap_local_secure_checkout() {
  if [[ -L "$1" ]]; then return 0; fi
  find "$1" ! -type l \( -perm -g=w -o -perm -o=w \) -exec chmod go-w {} + 2>/dev/null || true
  return 0
}

# Whether every path given exists and is owned by the current user (a link is judged by what
# it points to for a directory, and by itself for .git).
ap_local_owned_by_me() {
  local p uid
  for p in "$@"; do
    read -r _ _ uid _ <<<"$(ls -ldn "$p" 2>/dev/null)" || return 1
    if [[ "${p##*/}" != ".git" ]]; then
      read -r _ _ uid _ <<<"$(ls -ldnL "$p" 2>/dev/null)" || return 1
    fi
    if [[ "$uid" != "$(id -u)" ]]; then return 1; fi
  done
  return 0
}

# Whether the file $1 is a regular file (not a link) whose top-level "name" is
# agentpulse. With python3 the JSON is parsed. Without it, a line is accepted only
# if it is a key at the indentation of the file's first key inside a leading "{"
# line, so a nested "name" doesn't count; anything it can't decide is a no.
ap_local_is_agentpulse_package() {
  local f="$1"
  if [[ ! -f "$f" || -L "$f" ]]; then return 1; fi
  if need_cmd python3; then
    if python3 -I -c 'import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if isinstance(d, dict) and d.get("name") == "agentpulse" else 1)' "$f" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  if awk '
    NR == 1 { if ($0 !~ /^[ \t]*\{[ \t]*$/) exit 1; next }
    NR == 2 { match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH); if (RLENGTH == 0) exit 1 }
    ($0 ~ ("^" ind "\"name\"[ \t]*:[ \t]*\"agentpulse\"[ \t]*,?[ \t]*$")) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$f" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Chooses BUN_BIN, BUN_DIR and BUN_NEEDS_INSTALL. With BUN_INSTALL set to anything
# but the default Bun directory, its bin/bun is the only candidate: one that is there and unusable stops the run, and one that
# isn't there is installed. Otherwise ap_resolve_bun looks at the default Bun
# directory, PATH and the private copy in the AgentPulse directory.
ap_local_choose_bun() {
  local cand base="${BUN_INSTALL:-}"
  while [[ "$base" == */ && "$base" != "/" ]]; do base="${base%/}"; done
  # bun.sh's own installer writes the default Bun directory into shell profiles as
  # BUN_INSTALL, so that value says nothing about intent: it is treated as if BUN_INSTALL were unset.
  if [[ "$base" == "${HOME%/}/.bun" ]]; then
    unset BUN_INSTALL
  fi
  if [[ -n "${BUN_INSTALL:-}" ]]; then
    cand="$(ap_bun_install_candidate)"
    BUN_BIN="$cand"
    BUN_DIR="$(dirname "$cand")"
    BUN_NEEDS_INSTALL=1
    if [[ -e "$cand" || -L "$cand" ]]; then
      if ap_bun_acceptable "$cand"; then
        BUN_NEEDS_INSTALL=0
        return 0
      fi
      printf "  ✗ BUN_INSTALL points at a Bun this installer can't use: %q (%s). Fix it or unset BUN_INSTALL.\n" "$cand" "$AP_REASON" >&2
      return 1
    fi
    return 0
  fi
  ap_resolve_bun "${AGENTPULSE_DIR}/bun"
  return 0
}

# Follows the symbolic links at $1 with plain readlink (no -f, which macOS lacks),
# at most 40 hops, and prints the last path.
ap_link_target() {
  local p="$1" hops=0 t
  while [[ -L "$p" && "$hops" -lt 40 ]]; do
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname "$p")/$t" ;;
    esac
    hops=$((hops + 1))
  done
  echo "$p"
  return 0
}

# $1 with every symbolic link in its existing part resolved: the nearest directory
# that exists, through cd -P / pwd -P, plus the components that don't exist yet.
ap_local_physical() {
  local d="$1" rest="" real
  while [[ ! -d "$d" && "$d" != "/" && "$d" != "." ]]; do
    rest="/$(basename "$d")$rest"
    d="$(dirname "$d")"
  done
  if real="$(cd -P "$d" 2>/dev/null && pwd -P)"; then
    d="$real"
  fi
  echo "${d%/}$rest"
  return 0
}

# Refuses, with the overlap line, when the directory of the Bun $1 (shown as $2)
# sits in or under $4 ($3 names it) or under its physical form $5.
ap_local_overlap_one() {
  local dir="$1" shown="$2" what="$3" root="$4" rootp="$5"
  case "$dir/" in
    "$root/"*|"$rootp/"*)
      printf "  ✗ Bun would live at %q, inside %s %q, which this installer may delete. Choose another --dir or set BUN_INSTALL.\n" "$shown" "$what" "$root" >&2
      return 1
      ;;
  esac
  return 0
}

# The Bun must not live inside --dir or --data-dir: the install deletes and
# re-creates --dir. Compared by name, and by where BUN_BIN really is: its
# directory with every symbolic link resolved, after following a link at
# BUN_BIN itself.
ap_local_check_overlap() {
  local bun_dir target target_dir what root rootp
  bun_dir="$(dirname "$BUN_BIN")"
  target="$(ap_link_target "$BUN_BIN")"
  target_dir="$(ap_local_physical "$(dirname "$target")")"
  for what in --dir --data-dir; do
    if [[ "$what" == "--dir" ]]; then root="$INSTALL_DIR"; else root="$DATA_DIR"; fi
    rootp="$(ap_local_physical "$root")"
    ap_local_overlap_one "$bun_dir" "$BUN_BIN" "$what" "$root" "$rootp" || return 1
    ap_local_overlap_one "$target_dir" "$target" "$what" "$root" "$rootp" || return 1
  done
  return 0
}

# Everything this run needs that the machine may lack, named together: curl and
# git; python3 when the supervisor or the hooks will be configured with a key;
# and, when Bun has to be downloaded, a pinned release for this platform, unzip
# and a checksum tool. Prints one Missing block and returns 1 if any is absent.
ap_local_check_prereqs() {
  local missing="" hint t
  if ! need_cmd curl; then missing="curl"; fi
  if ! need_cmd git; then missing="${missing:+$missing }git"; fi
  if [[ "${AUTO_SUPERVISOR}" == "true" || "${AUTO_HOOKS}" == "true" ]] \
    && [[ "${DISABLE_AUTH}" == "true" || -n "${API_KEY}" ]] \
    && ! need_cmd python3; then
    missing="${missing:+$missing }python3"
  fi
  if [[ "${BUN_NEEDS_INSTALL}" == 1 ]]; then
    AP_BUN_ASSET="$(ap_bun_asset)"
    if [[ -z "$AP_BUN_ASSET" ]]; then
      echo "  ✗ There's no pinned Bun ${BUN_VERSION} release for $(uname -s)/$(uname -m). Install Bun ${BUN_MIN_VERSION} or newer and run this installer again, or set BUN_INSTALL to where it is." >&2
      return 1
    fi
    t="$(ap_missing_bun_tools)"
    if [[ -n "$t" ]]; then missing="${missing:+$missing }$t"; fi
  fi
  if [[ -z "$missing" ]]; then return 0; fi
  # shellcheck disable=SC2086 # tool names, split on purpose
  hint="$(ap_install_hint $missing)"
  {
    echo "  ✗ Missing: $missing"
    if [[ -n "$hint" ]]; then
      echo "    Install with: $hint"
    else
      echo "    Install them with your system's package manager."
    fi
    case " $missing " in
      *" python3 "*) echo "    (python3 is used by the local supervisor and the agent hooks; --skip-supervisor --skip-hooks installs without it.)" ;;
    esac
    echo "    Then run this installer again. Nothing was installed."
  } >&2
  return 1
}

# mkdir -p with the caller's umask plus 022, so directories made on the way (a
# --dir under a path that doesn't exist yet) are never group- or world-writable,
# and a stricter umask than that is kept.
ap_local_mkdir_p() {
  local m
  m="$(umask)"
  ( umask "$(printf '%04o' $((8#$m | 8#022)))" && mkdir -p "$@" ) || return 1
  return 0
}

# Runs the command "$@" with the caller's umask plus 022, so what git and bun write
# into the checkout is never group- or world-writable (Fedora's default is 002).
ap_local_with_umask() {
  local m
  m="$(umask)"
  ( umask "$(printf '%04o' $((8#$m | 8#022)))" && "$@" )
}

# Creates the directory $1 at mode 700 (its parent as usual). A directory that
# already exists is re-moded to 700 when it is AgentPulse's own default ($2 is
# "default") and left alone when the user chose it ($2 "given"), with a note if
# other users can read it.
ap_local_private_dir() {
  local mode
  if [[ -d "$1" ]]; then
    if [[ "$2" == "default" ]]; then
      if [[ -O "$1" ]]; then chmod 700 "$1" 2>/dev/null || true; fi
      return 0
    fi
    read -r mode _ <<<"$(ls -ldn "$1" 2>/dev/null)" || return 0
    if [[ "${mode:4:6}" != "------" ]]; then
      printf "  ! %q can be read by other users; run chmod 700 %q to keep AgentPulse's data private.\n" "$1" "$1"
    fi
    return 0
  fi
  ap_local_mkdir_p "$(dirname "$1")"
  ( umask 077 && mkdir "$1" )
  return 0
}

# The lines of .env.local. This is the one place the file's content and the names it may
# hold are defined: ap_local_env_run exports only the names printed here.
ap_local_env_content() {
  cat <<EOF
PORT=${PORT}
HOST=${HOST}
PUBLIC_URL=${PUBLIC_URL}
DISABLE_AUTH=${DISABLE_AUTH}
AGENTPULSE_INITIAL_API_KEY=${API_KEY}
DATA_DIR=${DATA_DIR}
SQLITE_PATH=${DATA_DIR}/agentpulse.db
NODE_ENV=production
EOF
  return 0
}

# Runs the command "$@" in place of this (background) shell with the NAME=value lines of
# the file $1 exported, but only the names ap_local_env_content writes (so a PATH= or
# BASH_ENV= line added to the file later changes nothing). Each line stays one word (no
# splitting, no globbing), and the values are never on a command line. Any other line is
# skipped, by number and without its text, which may be a key. Only called in the background, where exec
# keeps $! the pid of the command itself.
ap_local_env_run() {
  local file="$1" line name n=0 allowed
  allowed=" $(ap_local_env_content | sed 's/=.*//' | tr '\n' ' ')"
  shift
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ -z "$line" ]]; then continue; fi
    name="${line%%=*}"
    if [[ "$line" != *=* ]] || [[ "$allowed" != *" $name "* ]]; then
      echo "  ! Skipping line $n of $file: it isn't one of the settings the installer writes" >&2
      continue
    fi
    export "$line"
  done < "$file"
  exec "$@"
}

# Escapes the five XML characters in $1, & first.
ap_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
  return 0
}
# <<< agentpulse-local-prereqs

ap_local_validate_args

if [[ -z "${PUBLIC_URL}" ]]; then
  PUBLIC_URL="http://localhost:${PORT}"
fi

echo ""
echo "  AgentPulse Local Install"
echo "  ────────────────────────"
echo "  Repo:       ${REPO_URL} (${REPO_REF})"
echo "  Install:    ${INSTALL_DIR}"
echo "  Data:       ${DATA_DIR}"
echo "  URL:        ${PUBLIC_URL}"
echo "  Hooks:      ${AUTO_HOOKS}"
echo "  Supervisor: ${AUTO_SUPERVISOR}"
echo "  Service:    ${SERVICE_MODE}"
echo ""

# Everything below up to the first write only reads.
ap_local_check_paths || exit 1
ap_local_preflight_services || exit 1
# A umask of 002 leaves the directories an earlier run made group-writable, which
# would make this run refuse its own private Bun. Only ours, and only ever narrowed.
# These are chmod'ed and written into, so a symbolic link in their place is refused, one level at
# a time: each is checked only after the one above it has been tightened, so nobody who isn't
# you can swap it for a link in between. What stays open is the top level, whose parent is your
# home directory: someone who can rename entries there already controls your shell startup
# files, and closing it would take a chmod that works on an open directory, which bash can't do.
ap_refuse_linked_dirs "${AGENTPULSE_DIR}" || exit 1
ap_tighten_dir "${AGENTPULSE_DIR}"
ap_refuse_linked_dirs "${AGENTPULSE_DIR}/bun" || exit 1
ap_tighten_dir "${AGENTPULSE_DIR}/bun"
ap_refuse_linked_dirs "${AGENTPULSE_DIR}/bun/bin" || exit 1
ap_tighten_dir "${AGENTPULSE_DIR}/bun/bin"
ap_local_choose_bun || exit 1
ap_local_check_overlap || exit 1
ap_local_check_install_dir || exit 1
ap_local_check_prereqs || exit 1

if [[ "${BUN_NEEDS_INSTALL}" == 1 ]]; then
  ap_check_bun_target "$BUN_BIN" || exit 1
  if ! AP_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agentpulse-install.XXXXXX")"; then
    printf "  ✗ couldn't create a temporary directory under %q\n" "${TMPDIR:-/tmp}" >&2
    exit 1
  fi
  trap 'rm -rf "${AP_TMP:?}"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # ~/.agentpulse is made private before Bun goes into it, so a umask of 002
  # doesn't leave it group-writable with the binary already inside.
  ( umask 077 && mkdir -p "${AGENTPULSE_DIR}" ) || { printf "  ✗ couldn't create %q\n" "${AGENTPULSE_DIR}" >&2; exit 1; }
  echo "  Installing Bun ${BUN_VERSION} into ${BUN_DIR}..."
  ap_install_pinned_bun "$AP_BUN_ASSET" "$BUN_BIN" "$AP_TMP/bun" || exit 1
  if ! ap_bun_acceptable "$BUN_BIN"; then
    rm -f "$BUN_BIN"
    printf "  ✗ the Bun just installed at %q isn't usable (%s)\n" "$BUN_BIN" "$AP_REASON" >&2
    exit 1
  fi
  rm -rf "${AP_TMP:?}"
  trap - EXIT INT TERM
fi
echo "  ✓ Bun: ${BUN_BIN} ($("$BUN_BIN" --version </dev/null))"
export PATH="${BUN_DIR}:${PATH}"
# What the services put in front of the system PATH: this Bun's directory, then
# the default Bun directory (when it is a different one, exists and is safe to
# put on a PATH), so `bun add -g` tools and bunx stay reachable for agents the
# supervisor launches.
SERVICE_BUN_PATH="${BUN_DIR}"
AP_DEFAULT_BUN_BIN="${HOME%/}/.bun/bin"
if [[ "${BUN_DIR}" != "${AP_DEFAULT_BUN_BIN}" && -d "${AP_DEFAULT_BUN_BIN}" ]]; then
  if ap_owner_ok "${AP_DEFAULT_BUN_BIN}"; then
    SERVICE_BUN_PATH="${BUN_DIR}:${AP_DEFAULT_BUN_BIN}"
  else
    printf '  ! Not adding %q to the service PATH: %s\n' "${AP_DEFAULT_BUN_BIN}" "${AP_REASON}"
  fi
fi

ap_local_private_dir "${AGENTPULSE_DIR}" default
ap_local_private_dir "${LOG_DIR}" default
if [[ "${DATA_DIR_GIVEN}" == "true" ]]; then
  ap_local_private_dir "${DATA_DIR}" given
else
  ap_local_private_dir "${DATA_DIR}" default
fi
ap_local_mkdir_p "$(dirname "${INSTALL_DIR}")"

if [[ -d "${INSTALL_DIR}/.git" || -f "${INSTALL_DIR}/.git" ]]; then
  echo "  Updating existing checkout..."
  # A umask of 002 left an earlier clone group-writable; git reads hooks and config from here,
  # so everything in it is narrowed before git runs. A directory the user chose is theirs to
  # set the mode of.
  if [[ "${INSTALL_DIR_GIVEN}" != "true" ]]; then
    ap_local_secure_checkout "${INSTALL_DIR}"
  fi
  ap_local_with_umask git -C "${INSTALL_DIR}" fetch --tags origin </dev/null
  ap_local_with_umask git -C "${INSTALL_DIR}" checkout "${REPO_REF}" -- </dev/null
  ap_local_with_umask git -C "${INSTALL_DIR}" pull --ff-only origin "${REPO_REF}" </dev/null || true
else
  echo "  Cloning repository..."
  # Checked again here: the earlier check ran before the Bun install, which can take a while.
  ap_local_check_install_dir || exit 1
  rm -rf "${INSTALL_DIR}"
  ap_local_with_umask git clone --branch "${REPO_REF}" --single-branch -- "${REPO_URL}" "${INSTALL_DIR}" </dev/null
fi
# A directory the user chose is theirs to set the mode of, as --data-dir is.
if [[ "${INSTALL_DIR_GIVEN}" != "true" ]]; then
  ap_tighten_dir "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

echo "  Installing dependencies..."
ap_local_with_umask "${BUN_BIN}" install </dev/null

echo "  Building application..."
ap_local_with_umask env NODE_ENV=production "${BUN_BIN}" run build </dev/null

ENV_FILE="${INSTALL_DIR}/.env.local"
ENV_CONTENT="$(ap_local_env_content)"$'\n'
ap_write_private_no_follow "${ENV_FILE}" "${ENV_CONTENT}" || exit 1
echo "  ✓ Wrote ${ENV_FILE}"

SUPERVISOR_CONFIG_FILE="${AGENTPULSE_DIR}/supervisor.json"
SUPERVISOR_ENROLLMENT_TOKEN=""
# The only two plist values that can hold XML-special characters (a URL may hold & and ').
PUBLIC_URL_XML="$(ap_xml_escape "${PUBLIC_URL}")"
HOST_XML="$(ap_xml_escape "${HOST}")"

json_escape() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

configure_supervisor() {
  local trusted_root="${HOME}/dev"
  if [[ ! -d "${trusted_root}" ]]; then
    trusted_root="${HOME}"
  fi

  local enrollment_json="null"
  local api_key_json="null"
  local claude_json="null"
  local codex_json="null"

  if [[ -n "${SUPERVISOR_ENROLLMENT_TOKEN}" ]]; then
    enrollment_json="$(json_escape "${SUPERVISOR_ENROLLMENT_TOKEN}")"
  fi
  if [[ -n "${API_KEY}" ]]; then
    api_key_json="$(json_escape "${API_KEY}")"
  fi
  if command -v claude >/dev/null 2>&1; then
    claude_json="$(json_escape "$(command -v claude)")"
  fi
  if command -v codex >/dev/null 2>&1; then
    codex_json="$(json_escape "$(command -v codex)")"
  fi

  local merged_json
  merged_json="$(python3 - "${SUPERVISOR_CONFIG_FILE}" "${PUBLIC_URL}" "${trusted_root}" "${enrollment_json}" "${api_key_json}" "${claude_json}" "${codex_json}" <<'PY'
import json, os, socket, sys
path, server_url, trusted_root, enrollment_json, api_key_json, claude_json, codex_json = sys.argv[1:]
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
data["serverUrl"] = server_url
data["hostName"] = data.get("hostName") or socket.gethostname()
data["trustedRoots"] = data.get("trustedRoots") or [trusted_root]
enrollment = json.loads(enrollment_json)
if enrollment:
    data["enrollmentToken"] = enrollment
api_key = json.loads(api_key_json)
if api_key:
    data["apiKey"] = api_key
claude = json.loads(claude_json)
if claude:
    data["claudeCommand"] = claude
codex = json.loads(codex_json)
if codex:
    data["codexCommand"] = codex
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
  )"
  # AGEN-21: was a bare python3 `open(path, "w")` — follows a symlink at the
  # destination and leaves the file at the OS-default create mode (0644
  # under a typical umask). supervisor.json holds the supervisor credential
  # / enrollment token in plaintext; ap_write_private_no_follow (above)
  # writes it at 0600 without following a symlink.
  ap_write_private_no_follow "${SUPERVISOR_CONFIG_FILE}" "${merged_json}"$'\n' || exit 1
  echo "  ✓ Wrote ${SUPERVISOR_CONFIG_FILE}"
}

create_systemd() {
  ap_local_mkdir_p "${HOME}/.config/systemd/user"
  local unit="${HOME}/.config/systemd/user/${SERVICE_NAME}.service" content
  content="$(cat <<EOF
[Unit]
Description=AgentPulse local server
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
Environment=HOME=${HOME}
Environment=PATH=${SERVICE_BUN_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=${BUN_BIN} run start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
)"$'\n'
  ap_write_private_no_follow "${unit}" "${content}" || exit 1
  systemctl --user daemon-reload </dev/null
  systemctl --user enable "${SERVICE_NAME}" >/dev/null </dev/null
  systemctl --user restart "${SERVICE_NAME}" </dev/null
  echo "  ✓ systemd user service started"
  echo "    Logs: journalctl --user -u ${SERVICE_NAME} -f"
}

create_supervisor_systemd() {
  ap_local_mkdir_p "${HOME}/.config/systemd/user"
  local unit="${HOME}/.config/systemd/user/${SERVICE_NAME}-supervisor.service" content
  content="$(cat <<EOF
[Unit]
Description=AgentPulse local supervisor
After=network.target ${SERVICE_NAME}.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
Environment=HOME=${HOME}
Environment=PATH=${SERVICE_BUN_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=${BUN_BIN} run supervisor
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
)"$'\n'
  ap_write_private_no_follow "${unit}" "${content}" || exit 1
  systemctl --user daemon-reload </dev/null
  systemctl --user enable "${SERVICE_NAME}-supervisor" >/dev/null </dev/null
  systemctl --user restart "${SERVICE_NAME}-supervisor" </dev/null
  echo "  ✓ systemd supervisor started"
  echo "    Logs: journalctl --user -u ${SERVICE_NAME}-supervisor -f"
}

create_launchd() {
  ap_local_mkdir_p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
  local plist="${HOME}/Library/LaunchAgents/dev.agentpulse.local.plist" content
  content="$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.local</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_BIN}</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>${SERVICE_BUN_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>${PORT}</string>
    <key>HOST</key><string>${HOST_XML}</string>
    <key>PUBLIC_URL</key><string>${PUBLIC_URL_XML}</string>
    <key>DISABLE_AUTH</key><string>${DISABLE_AUTH}</string>
    <key>AGENTPULSE_INITIAL_API_KEY</key><string>${API_KEY}</string>
    <key>DATA_DIR</key><string>${DATA_DIR}</string>
    <key>SQLITE_PATH</key><string>${DATA_DIR}/agentpulse.db</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/agentpulse.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/agentpulse.err.log</string>
</dict>
</plist>
EOF
)"$'\n'
  ap_write_private_no_follow "${plist}" "${content}" || exit 1
  launchctl unload "${plist}" >/dev/null 2>&1 </dev/null || true
  launchctl load "${plist}" </dev/null
  echo "  ✓ launchd service started"
  echo "    Logs: tail -f ${LOG_DIR}/agentpulse.out.log"
}

create_supervisor_launchd() {
  ap_local_mkdir_p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
  local plist="${HOME}/Library/LaunchAgents/dev.agentpulse.supervisor.plist" content
  content="$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agentpulse.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_BIN}</string>
    <string>run</string>
    <string>supervisor</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>${SERVICE_BUN_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>${PORT}</string>
    <key>HOST</key><string>${HOST_XML}</string>
    <key>PUBLIC_URL</key><string>${PUBLIC_URL_XML}</string>
    <key>DISABLE_AUTH</key><string>${DISABLE_AUTH}</string>
    <key>AGENTPULSE_INITIAL_API_KEY</key><string>${API_KEY}</string>
    <key>DATA_DIR</key><string>${DATA_DIR}</string>
    <key>SQLITE_PATH</key><string>${DATA_DIR}/agentpulse.db</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/supervisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/supervisor.err.log</string>
</dict>
</plist>
EOF
)"$'\n'
  ap_write_private_no_follow "${plist}" "${content}" || exit 1
  launchctl unload "${plist}" >/dev/null 2>&1 </dev/null || true
  launchctl load "${plist}" </dev/null
  echo "  ✓ launchd supervisor started"
  echo "    Logs: tail -f ${LOG_DIR}/supervisor.out.log"
}

case "${SERVICE_MODE}" in
  systemd)
    create_systemd
    ;;
  launchd)
    create_launchd
    ;;
  none)
    echo "  Starting AgentPulse in the background..."
    ap_local_env_run "${ENV_FILE}" "${BUN_BIN}" run start </dev/null > "${LOG_DIR}/agentpulse.out.log" 2>&1 &
    echo $! > "${AGENTPULSE_DIR}/agentpulse.pid"
    echo "  ✓ Started background process"
    echo "    Logs: tail -f ${LOG_DIR}/agentpulse.out.log"
    ;;
esac

echo ""
echo "  Waiting for AgentPulse to start..."
for _ in $(seq 1 30); do
  if curl -fsSL "${PUBLIC_URL}/api/v1/health" >/dev/null 2>&1; then
    echo "  ✓ AgentPulse is running at ${PUBLIC_URL}"
    echo ""
    if [[ "${AUTO_SUPERVISOR}" == "true" ]]; then
      if [[ "${DISABLE_AUTH}" != "true" ]]; then
        if [[ -n "${API_KEY}" ]]; then
          echo "  Creating local supervisor enrollment token..."
          SUPERVISOR_ENROLLMENT_TOKEN="$(
            curl -fsSL -X POST \
              -H "Authorization: Bearer ${API_KEY}" \
              -H "Content-Type: application/json" \
              "${PUBLIC_URL}/api/v1/supervisors/enroll" \
              -d '{"name":"local-supervisor"}' \
            | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
          )"
          echo "  ✓ Enrollment token issued"
        else
          echo "  ! Skipping supervisor auto-install because auth is enabled and no --api-key was provided."
          echo "    Add a supervisor later from Hosts, or rerun with --api-key."
          echo ""
        fi
      fi
      if [[ "${DISABLE_AUTH}" == "true" || -n "${SUPERVISOR_ENROLLMENT_TOKEN}" ]]; then
        echo "  Configuring local supervisor..."
        configure_supervisor
        case "${SERVICE_MODE}" in
          systemd)
            create_supervisor_systemd
            ;;
          launchd)
            create_supervisor_launchd
            ;;
          none)
            echo "  Starting AgentPulse supervisor in the background..."
            HOME="${HOME}" PATH="${SERVICE_BUN_PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
              ap_local_env_run "${ENV_FILE}" "${BUN_BIN}" run supervisor </dev/null > "${LOG_DIR}/supervisor.out.log" 2> "${LOG_DIR}/supervisor.err.log" &
            echo $! > "${AGENTPULSE_DIR}/supervisor.pid"
            echo "  ✓ Started background supervisor"
            echo "    Logs: tail -f ${LOG_DIR}/supervisor.out.log"
            ;;
        esac
        echo ""
      fi
    fi
    if [[ "${AUTO_HOOKS}" == "true" ]]; then
      if [[ "${DISABLE_AUTH}" == "true" ]]; then
        echo "  Configuring Claude Code + Codex hooks..."
        curl -fsSL "${PUBLIC_URL}/setup.sh" | bash
        echo ""
        echo "  ✓ Hooks configured"
      elif [[ -n "${API_KEY}" ]]; then
        echo "  Configuring Claude Code + Codex hooks with API key..."
        curl -fsSL "${PUBLIC_URL}/setup.sh" | bash -s -- --key "${API_KEY}"
        echo ""
        echo "  ✓ Hooks configured"
      else
        echo "  ! Skipping automatic hook setup because auth is enabled and no --api-key was provided."
        echo "    Run this next (the key is asked for at a hidden prompt, never in the command itself):"
        echo "      ( ap_key=\$(if [ -t 0 ]; then s=\$(stty -g 2>/dev/null) && stty -echo 2>/dev/null || { echo \"Can't hide the key while you type it, so it won't be asked for here. Use the scripted form in the docs instead.\" >&2; exit 1; }; trap 'echo >&2; exit 130' INT TERM HUP; trap 'stty \"\$s\" 2>/dev/null' EXIT; fi; printf 'AgentPulse API key: ' >&2; IFS= read -r k; if [ -t 0 ]; then echo >&2; fi; printf %s \"\$k\") && case \"\$ap_key\" in '') echo \"No API key entered; nothing was installed.\" >&2; false;; *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) echo \"The API key can only contain letters, digits, '.', '_' and '-'; nothing was installed.\" >&2; false;; *) export AGENTPULSE_KEY=\"\$ap_key\"; curl -sSL ${PUBLIC_URL}/setup.sh | bash;; esac )"
        echo ""
      fi
    else
      echo "  Next step:"
      echo "    curl -fsSL ${PUBLIC_URL}/setup.sh | bash"
      echo ""
    fi
    echo "  Local control plane:"
    if [[ "${AUTO_SUPERVISOR}" == "true" ]]; then
      echo "    enabled"
    else
      echo "    skipped (--skip-supervisor)"
    fi
    echo "  Open:"
    echo "    ${PUBLIC_URL}"
    exit 0
  fi
  sleep 1
done

echo ""
echo "  AgentPulse was installed but the health check did not pass in time."
echo "  Try starting it manually:"
echo "    cd ${INSTALL_DIR}"
echo "    export \$(cat .env.local | xargs)"
echo "    ${BUN_BIN} run start"
exit 1
}
