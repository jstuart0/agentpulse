#!/usr/bin/env bash
# transcript-sync.ts runs on a timer inside the server process, so it must use
# async file IO only. Plain grep, deliberately: an optional search tool that
# might be missing, behind an `|| true`, would turn "could not search" into
# "found nothing". A missing file or a failing grep fails this guard.
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
[[ "$script_dir" == "$script_path" ]] && script_dir="."
cd "$script_dir/.."

TARGET=src/server/services/transcript-sync.ts

command -v grep >/dev/null || { echo "ERROR: grep is required by this guard but was not found" >&2; exit 2; }
[[ -f "$TARGET" ]] || { echo "ERROR: $TARGET does not exist, so this guard would scan nothing" >&2; exit 2; }

set +e
matches="$(grep -nE 'readFileSync|statSync|existsSync' "$TARGET")"
status=$?
set -e
if (( status > 1 )); then
  echo "ERROR: grep failed (exit $status) while scanning $TARGET" >&2
  exit 2
fi

if [[ -n "$matches" ]]; then
  echo "Synchronous transcript IO is not allowed in $TARGET:"
  echo "$matches"
  exit 1
fi

echo "OK: transcript-sync.ts uses no synchronous file IO"
