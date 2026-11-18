# >>> agentpulse-shim
# The ~/.agentpulse/bin/agentpulse shim: one POSIX sh file that runs AgentPulse's own commands with the
# Bun the installer chose, so the command works from any shell without Bun on PATH. scripts/lib/shim.sh
# is the source; install-local.sh carries a byte-identical copy (scripts/shim.test.ts checks it), since
# the installer is a single file that arrives through `curl | bash`.

# $1 as a single-quoted sh word. A newline is refused (a path never holds one).
ap_sh_quote() {
  case "$1" in
    *"
"*) return 1 ;;
  esac
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
  return 0
}

# The text of the shim for the Bun $1 and the checkout $2 (both absolute), ending in one newline.
ap_render_shim() {
  local bun_q dir_q
  bun_q="$(ap_sh_quote "$1")" || return 1
  dir_q="$(ap_sh_quote "$2")" || return 1
  cat <<SHIM
#!/bin/sh
# Written by the AgentPulse installer and rewritten by it; edits here are lost.
if [ "\$(id -u)" = 0 ]; then
  echo "Don't run agentpulse as root." >&2
  exit 1
fi
if [ -z "\${HOME-}" ]; then
  echo "agentpulse: HOME is not set." >&2
  exit 1
fi
BUN_BIN=${bun_q}
INSTALL_DIR=${dir_q}
if [ "\${1-}" = update ]; then
  bundle="\$HOME/.agentpulse/updater/current/updater.js"
  if [ ! -f "\$bundle" ]; then
    echo "updates arrive with 0.12.0"
    exit 0
  fi
  cd "\$HOME/.agentpulse" || exit 1
  AGENTPULSE_UPDATER_REAL_SERVICES=1
  export AGENTPULSE_UPDATER_REAL_SERVICES
  exec "\$BUN_BIN" "\$bundle" "\$@"
fi
unset AGENTPULSE_UPDATER_REAL_SERVICES
exec "\$BUN_BIN" "\$INSTALL_DIR/bin/cli.ts" "\$@"
SHIM
  return 0
}
# <<< agentpulse-shim
