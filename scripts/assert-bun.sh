#!/usr/bin/env bash
# assert-bun.sh: run `bun test` with the junit reporter and check that the run is both green AND the
# size and shape the gate expects, so a suite that quietly lost its tests (a skipped file, a renamed
# describe, a deleted case) fails the gate instead of passing with fewer tests.
#
# Usage:
#   scripts/assert-bun.sh [--min N] [--require TEXT]... [--require-file PATH]... -- <bun test arguments>
#
#   --min N              the run must PASS at least N tests (tests - failures - skipped). Default 1:
#                        a run that passes nothing is never green
#   --require TEXT       some test that PASSED must have TEXT in its name or in its describe's name
#   --require-file PATH  some test from the file PATH must have passed. PATH must be spelled exactly as
#                        bun reports it in the junit `file=` attribute: relative to the directory this
#                        script runs in, with no leading ./ (src/server/routes/x.test.ts). A near-miss
#                        spelling is "MISSING", never a silent pass
#
# Everything after `--` goes to `bun test` (files, --timeout, ...); the junit reporter is added here.
# Exit 0 only if bun test exited 0 and every assertion held. The junit report is written to a fresh
# file on every run (mktemp, so a report from an earlier run can never be mistaken for this one);
# its path is printed. Set ASSERT_BUN_OUT to choose the directory-and-prefix it is created under.
set -uo pipefail

min=1
requires=()
required_files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --min) min="${2:?--min needs a number}"; shift 2 ;;
    --require) requires+=("${2:?--require needs text}"); shift 2 ;;
    --require-file) required_files+=("${2:?--require-file needs a path}"); shift 2 ;;
    --) shift; break ;;
    *) echo "assert-bun: unknown option '$1'" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "assert-bun: nothing to run after --" >&2; exit 2; }

out="$(mktemp "${ASSERT_BUN_OUT:-${TMPDIR:-/tmp}/assert-bun}.XXXXXX")" || { echo "assert-bun: cannot create a report file" >&2; exit 2; }
echo "assert-bun: junit report: $out" >&2

bun test --reporter=junit --reporter-outfile="$out" "$@"
bun_status=$?

fail=0
say() { echo "assert-bun: $*" >&2; }

if [ ! -s "$out" ]; then say "bun test wrote no junit report"; exit 1; fi

root=$(grep -m1 '<testsuites ' "$out")
attr() { echo "$root" | sed -n "s/.* $1=\"\([0-9]*\)\".*/\1/p"; }
tests=$(attr tests); failures=$(attr failures); skipped=$(attr skipped)
tests=${tests:-0}; failures=${failures:-0}; skipped=${skipped:-0}
passed=$((tests - failures - skipped))
say "tests=$tests passed=$passed failed=$failures skipped=$skipped (min $min)"

[ "$bun_status" -eq 0 ] || { say "bun test exited $bun_status"; fail=1; }
[ "$failures" -eq 0 ] || { say "$failures test(s) failed"; fail=1; }
if [ "$passed" -lt "$min" ]; then say "only $passed tests passed, expected at least $min"; fail=1; fi

# A passing testcase is a self-closing element; a failed or skipped one carries a child element.
passing=$(grep -E '<testcase .*/>[[:space:]]*$' "$out" || true)
# For name matching, drop the file attribute so a path can't satisfy a --require by accident.
passing_names=$(printf '%s\n' "$passing" | sed 's/ file="[^"]*"//')

for text in "${requires[@]+"${requires[@]}"}"; do
  # here-strings, not a pipe into grep -q: with pipefail an early-exiting grep would fail the pipeline
  if grep -qF -- "$text" <<<"$passing_names"; then
    say "ok: a passing test matches '$text'"
  else
    say "MISSING: no passing test has '$text' in its name or its describe's name"; fail=1
  fi
done
for file in "${required_files[@]+"${required_files[@]}"}"; do
  if grep -qF -- "file=\"$file\"" <<<"$passing"; then
    say "ok: $file ran and passed"
  else
    say "MISSING: no passing test from $file"; fail=1
  fi
done

exit "$fail"
