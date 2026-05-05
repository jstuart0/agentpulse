#!/usr/bin/env bash
# db-generate.sh — generate Drizzle migration baselines for both dialects.
#
# Runs drizzle-kit for SQLite and Postgres sequentially. Uses the Node.js
# CJS hook (scripts/drizzle-hook.cjs) to remap .js extension imports to
# .ts so drizzle-kit's bundler can resolve the project's ESM-style schema
# files without modification.
#
# Phase 8 will harden this script with a diff-check to detect schema drift.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[db-generate] Generating SQLite baseline..."
node --require ./scripts/drizzle-hook.cjs ./node_modules/drizzle-kit/bin.cjs generate \
  --config drizzle.config.sqlite.ts

echo "[db-generate] Generating Postgres baseline..."
node --require ./scripts/drizzle-hook.cjs ./node_modules/drizzle-kit/bin.cjs generate \
  --config drizzle.config.postgres.ts

echo "[db-generate] Done."
