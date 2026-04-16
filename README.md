# AgentPulse

Real-time monitoring dashboard for AI coding agent sessions.

Track what your Claude Code and Codex CLI agents are doing across all your terminal tabs in one place.

## Features

- **Real-time dashboard** -- see all active agent sessions at a glance
- **Multi-agent support** -- works with Claude Code and Codex CLI
- **Zero-script hooks** -- uses native HTTP hooks, no shell scripts required
- **Semantic status** -- agents report what they're working on, not just what tools they called
- **Session timeline** -- detailed event history for each session
- **CLAUDE.md editor** -- view and edit agent instructions from the dashboard
- **Self-hosted** -- runs on your own infrastructure, no cloud dependency
- **Configurable database** -- SQLite (default) or PostgreSQL

## Install

### 1. Start the server (pick one)

```bash
# Docker (easiest -- no dependencies needed)
docker run -d -p 3000:3000 -v agentpulse-data:/app/data --name agentpulse ghcr.io/jaystuart/agentpulse

# Or with Bun
git clone https://github.com/jaystuart/agentpulse.git && cd agentpulse
bun install && bun run build && bun run start

# Or docker-compose
git clone https://github.com/jaystuart/agentpulse.git && cd agentpulse
docker compose up -d
```

### 2. Connect your agents (one command)

```bash
# If your server has auth disabled (DISABLE_AUTH=true):
curl -sSL http://localhost:3000/setup.sh | bash

# If your server requires an API key (shown in server logs on first start):
curl -sSL http://localhost:3000/setup.sh | bash -s -- --key ap_YOUR_KEY

# For a remote server:
curl -sSL https://your-server.com/setup.sh | bash -s -- --url https://your-server.com --key ap_YOUR_KEY
```

That's it. Open `http://localhost:3000` and start a new Claude Code or Codex session.

### What the setup does

- Configures Claude Code hooks in `~/.claude/settings.json` (10 events)
- Configures Codex CLI hooks in `~/.codex/hooks.json` (5 events)
- Enables the Codex hooks feature flag
- Adds `AGENTPULSE_API_KEY` to your shell profile (if key provided)
- Sends a test event to verify connectivity

## Kubernetes

```bash
kubectl apply -f deploy/k8s/
```

## Tech Stack

- [Bun](https://bun.sh) -- JavaScript runtime
- [Hono](https://hono.dev) -- Web framework
- [React 19](https://react.dev) -- UI framework
- [TailwindCSS](https://tailwindcss.com) -- Styling
- [shadcn/ui](https://ui.shadcn.com) -- Component library
- [Drizzle ORM](https://orm.drizzle.team) -- Database ORM
- [Zustand](https://zustand.docs.pmnd.rs) -- State management

## License

MIT
