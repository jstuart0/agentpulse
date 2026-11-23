#!/usr/bin/env bash
# Proves the build the updater stages works with install scripts off: clones HEAD of this checkout into a
# scratch directory, then runs the same two commands the updater runs there.
#
#   bun install --frozen-lockfile --ignore-scripts
#   NODE_ENV=production bun run build
#
# If a dependency needs its install script, this fails and names the step. Do not drop --ignore-scripts to
# make it pass (the update path never runs a fetched package's lifecycle scripts).
#
# Usage: bash scripts/release/check-staged-build.sh [scratch-parent-dir]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="${1:-${TMPDIR:-/tmp}}"
scratch="$(mktemp -d "${parent%/}/agentpulse-staged-build.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Local clone only: no network for git, no user config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
git -c protocol.file.allow=always clone --quiet --no-hardlinks "$repo_root" "$scratch/app"
cd "$scratch/app"

echo "staged-build: bun install --frozen-lockfile --ignore-scripts"
if ! bun install --frozen-lockfile --ignore-scripts; then
  echo "staged-build: FAILED at install (frozen lockfile or fetch)" >&2
  exit 1
fi

echo "staged-build: bun run build"
if ! NODE_ENV=production bun run build; then
  echo "staged-build: FAILED at build. If a dependency needs its install script, name it here; do not drop --ignore-scripts." >&2
  exit 1
fi

test -f dist/server/index.js || { echo "staged-build: FAILED: dist/server/index.js missing" >&2; exit 1; }
test -f dist/web/index.html || { echo "staged-build: FAILED: dist/web/index.html missing" >&2; exit 1; }
echo "staged-build: ok"
