# Codex Managed Mode

This branch contains a Phase 1 prototype for a supported Codex managed-mode flow.

## Goal

Automatically set the live Codex thread title using Codex's app-server protocol instead of:

- SQLite mutation
- terminal-specific title hacks
- manual `/rename` as the only option

The protocol surface confirmed in `codex-cli 0.121.0` is:

- request: `thread/name/set`
- notification: `thread/name/updated`

## Prototype

The prototype is intentionally isolated from production AgentPulse code paths.

File:

- `scripts/codex-managed-prototype.ts`

What it does:

1. Connects to a Codex app-server WebSocket endpoint.
2. Sends `initialize`.
3. Either:
   - starts a new thread with `thread/start`, or
   - renames an existing thread with `thread/name/set`.
4. Verifies the rename via `thread/name/updated`.
5. Reads the thread back with `thread/read`.

## Local Demo

Start a temporary loopback app-server and create a managed thread:

```bash
bun scripts/codex-managed-prototype.ts demo \
  --spawn-server \
  --url ws://127.0.0.1:8765 \
  --cwd "$PWD" \
  --name "agentpulse-demo"
```

Rename an existing thread:

```bash
bun scripts/codex-managed-prototype.ts set-name \
  --url ws://127.0.0.1:8765 \
  --thread-id <thread-id> \
  --name "firm-fern"
```

## What This Proves

- AgentPulse can use a supported Codex RPC to set thread names.
- The right long-term model is a control channel, not hook-only relay traffic.
- Managed mode should be built around a local Codex app-server connection.

## What This Does Not Yet Do

- Integrate with `POST /api/v1/hooks`
- launch Codex TUI in managed mode
- persist controller state in the database
- sync remote relay + local controller
- update the AgentPulse dashboard automatically after a managed rename

## Recommended Next Steps

1. Add a local controller service in the AgentPulse server process.
2. Add a managed-session metadata table.
3. Add an optional setup flow that launches Codex against a shared app-server.
4. Wire dashboard rename to `thread/name/set` for managed Codex sessions.
