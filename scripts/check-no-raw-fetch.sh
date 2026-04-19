#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

matches="$(rg -n 'fetch\(' src/web/pages src/web/components --glob '!src/web/lib/api.ts' || true)"

if [[ -n "$matches" ]]; then
  echo "Raw browser fetch() calls are not allowed outside src/web/lib/api.ts:"
  echo "$matches"
  exit 1
fi

echo "OK: no raw browser fetch() calls found outside api.ts"
