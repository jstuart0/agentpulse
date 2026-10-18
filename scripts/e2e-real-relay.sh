#!/bin/bash
# Runs the push modules against a real relay build and a mock APNs.
# Usage: AGENTPULSE_RELAY_DIR=/path/to/relay scripts/e2e-real-relay.sh
# The relay directory must hold a built relay (npm ci && npm run build there; this script builds it when
# dist/node.js is missing). It needs Node 24 on PATH. The relay listens on AGENTPULSE_E2E_RELAY_PORT (default 8797).
# Unlike the test file run on its own, a missing relay build here is a failure, not a skip.
set -euo pipefail

relay_dir="${AGENTPULSE_RELAY_DIR:-}"
[ -n "$relay_dir" ] || { echo "e2e-real-relay: set AGENTPULSE_RELAY_DIR to the relay directory" >&2; exit 2; }
[ -d "$relay_dir" ] || { echo "e2e-real-relay: $relay_dir is not a directory" >&2; exit 2; }

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 24 ] || { echo "e2e-real-relay: Node 24 or newer is required (found $node_major)" >&2; exit 2; }

if [ ! -f "$relay_dir/dist/node.js" ] || [ ! -f "$relay_dir/dist-dev/mock-apns.js" ]; then
  echo "e2e-real-relay: building the relay"
  (cd "$relay_dir" && npm ci && npm run build)
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
AGENTPULSE_RELAY_DIR="$relay_dir" \
AGENTPULSE_E2E_REQUIRE=1 \
AGENTPULSE_E2E_RELAY_PORT="${AGENTPULSE_E2E_RELAY_PORT:-8797}" \
  bun test src/server/services/push/real-relay.e2e.test.ts
