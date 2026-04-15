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

## Quick Start

```bash
# Clone the repo
git clone https://github.com/jaystuart/agentpulse.git
cd agentpulse

# Install dependencies
bun install

# Start development server
bun run dev

# Open http://localhost:5173
```

## Configure Agent Hooks

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "type": "http", "url": "http://localhost:3000/api/v1/hooks", "async": true, "headers": { "Authorization": "Bearer YOUR_API_KEY", "X-Agent-Type": "claude_code" } }],
    "Stop": [{ "type": "http", "url": "http://localhost:3000/api/v1/hooks", "async": true, "headers": { "Authorization": "Bearer YOUR_API_KEY", "X-Agent-Type": "claude_code" } }],
    "PostToolUse": [{ "type": "http", "url": "http://localhost:3000/api/v1/hooks", "async": true, "headers": { "Authorization": "Bearer YOUR_API_KEY", "X-Agent-Type": "claude_code" } }]
  }
}
```

### Codex CLI

Add to `~/.codex/hooks.json`:

```json
{
  "hooks": [
    { "event": "SessionStart", "type": "http", "url": "http://localhost:3000/api/v1/hooks", "async": true, "headers": { "Authorization": "Bearer YOUR_API_KEY", "X-Agent-Type": "codex_cli" } },
    { "event": "Stop", "type": "http", "url": "http://localhost:3000/api/v1/hooks", "async": true, "headers": { "Authorization": "Bearer YOUR_API_KEY", "X-Agent-Type": "codex_cli" } }
  ]
}
```

## Docker

```bash
docker compose up -d
```

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
