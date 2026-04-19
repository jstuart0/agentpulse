#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

matches="$(rg -n 'readFileSync|statSync|existsSync' src/server/services/transcript-sync.ts || true)"

if [[ -n "$matches" ]]; then
  echo "Synchronous transcript IO is not allowed in src/server/services/transcript-sync.ts:"
  echo "$matches"
  exit 1
fi

echo "OK: transcript-sync.ts uses no synchronous file IO"
