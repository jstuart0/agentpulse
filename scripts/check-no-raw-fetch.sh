#!/usr/bin/env bash
# Raw browser fetch() calls belong in src/web/lib/api.ts only (it owns auth
# handling and the error shape). Plain grep, deliberately: an optional search
# tool that might be missing, behind an `|| true`, would turn "could not
# search" into "found nothing". A missing directory or a failing grep fails
# this guard.
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
[[ "$script_dir" == "$script_path" ]] && script_dir="."
cd "$script_dir/.."

SCAN_DIRS=(src/web/pages src/web/components)

# Allowed exceptions: "path|the whole trimmed source line". A rule matches only
# a line that is exactly that text (so not the same text inside a longer line
# or followed by a comment), and each rule is used at most once per file, so a
# second identical call is still a violation.
#   LoginPage: the login/signup request runs before a session exists; going
#     through the API client would hand a failed login to its auth-bounce
#     reload instead of showing the error on the form.
#   AskPage: the streaming ask request reads a server-sent-event body and
#     handles an auth redirect itself (redirect: "manual"), which the JSON
#     API client cannot do.
ALLOWED=(
  'src/web/pages/LoginPage.tsx|const res = await fetch(endpoint, {'
  'src/web/pages/AskPage.tsx|res = await fetch(`${APP_API_BASE}/ai/ask/stream`, {'
)
used=()

command -v grep >/dev/null || { echo "ERROR: grep is required by this guard but was not found" >&2; exit 2; }
command -v find >/dev/null || { echo "ERROR: find is required by this guard but was not found" >&2; exit 2; }

for dir in "${SCAN_DIRS[@]}"; do
  [[ -d "$dir" ]] || { echo "ERROR: $dir does not exist, so this guard would scan nothing" >&2; exit 2; }
done

scanned="$(find "${SCAN_DIRS[@]}" -type f | wc -l | tr -d ' ')"
[[ "$scanned" -gt 0 ]] || { echo "ERROR: no files found under ${SCAN_DIRS[*]}" >&2; exit 2; }

set +e
found="$(grep -rnE 'fetch\(' "${SCAN_DIRS[@]}")"
status=$?
set -e
if (( status > 1 )); then
  echo "ERROR: grep failed (exit $status) while scanning ${SCAN_DIRS[*]}" >&2
  exit 2
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

matches=""
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  file="${line%%:*}"
  rest="${line#*:}"
  source_line="$(trim "${rest#*:}")"
  allowed=0
  for i in "${!ALLOWED[@]}"; do
    rule="${ALLOWED[$i]}"
    if [[ "$file" == "${rule%%|*}" && "$source_line" == "${rule#*|}" && -z "${used[$i]:-}" ]]; then
      used[i]=1
      allowed=1
      break
    fi
  done
  if (( allowed == 0 )); then
    matches+="$line"$'\n'
  fi
done <<< "$found"

if [[ -n "$matches" ]]; then
  echo "Raw browser fetch() calls are not allowed outside src/web/lib/api.ts:"
  printf '%s' "$matches"
  exit 1
fi

echo "OK: no raw browser fetch() calls found outside api.ts ($scanned files scanned)"
