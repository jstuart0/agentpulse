#!/usr/bin/env bash
# db-generate.sh — generate Drizzle migration baselines for both dialects.
#
# Run this script after any schema change. It generates per-dialect migration
# files for SQLite and Postgres and then verifies that the generated output
# has been committed. CI will fail if there is an uncommitted diff in drizzle/.
#
# Usage:
#   bun run db:generate          # via package.json wrapper
#   bash scripts/db-generate.sh  # directly
#
# Prerequisites: drizzle.config.sqlite.ts and drizzle.config.postgres.ts must
# both be present and correct. The drizzle-hook.cjs shim remaps .js extension
# imports to .ts so drizzle-kit's bundler can resolve schema files without
# modification.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[db-generate] Generating SQLite baseline..."
node --require ./scripts/drizzle-hook.cjs ./node_modules/drizzle-kit/bin.cjs generate \
  --config drizzle.config.sqlite.ts

echo "[db-generate] Generating Postgres baseline..."
node --require ./scripts/drizzle-hook.cjs ./node_modules/drizzle-kit/bin.cjs generate \
  --config drizzle.config.postgres.ts

echo "[db-generate] Checking for uncommitted migration drift..."
# Exit non-zero if either generate produced files that have not been staged.
# This catches the "forgot to commit generated migrations" footgun in CI and
# in pre-commit hooks. Run `git add drizzle/ && git commit` to resolve.
if ! git diff --exit-code drizzle/; then
  echo ""
  echo "[db-generate] ERROR: drizzle/ contains uncommitted changes after generate."
  echo "  Stage and commit the generated migration files before pushing:"
  echo "    git add drizzle/"
  echo "    git commit -m 'chore: update drizzle migrations'"
  exit 1
fi

echo "[db-generate] Done. Both dialects are up to date."
