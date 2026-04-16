# AgentPulse

**See what all your AI coding agents are doing -- in one place, in real time.**

If you run multiple Claude Code or Codex CLI sessions across different terminal tabs, you know the pain: *which tab is doing what?* AgentPulse gives you a live dashboard that shows every active session, what it's working on, and a scrollable chat history of everything you've said to each agent.

## How it works

```
Your terminal tabs                          AgentPulse dashboard
┌─────────────────┐                        ┌──────────────────────┐
│ Claude Code (1) │──── hook events ──────>│  bold-falcon: active │
│ fixing auth bug │                        │  "fix the auth bug"  │
├─────────────────┤                        ├──────────────────────┤
│ Claude Code (2) │──── hook events ──────>│  zen-owl: active     │
│ writing tests   │                        │  "add unit tests"    │
├─────────────────┤                        ├──────────────────────┤
│ Codex CLI       │──── hook events ──────>│  warm-crane: idle    │
│ (idle)          │                        │  last: 5m ago        │
└─────────────────┘                        └──────────────────────┘
```

Each session gets a random memorable name (like `bold-falcon`) so you can match the dashboard to your terminal tabs at a glance. Click any session to see a live chat-style timeline of your prompts and the agent's tool usage.

## Quick start (2 commands)

### Step 1: Start the server

```bash
docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true ghcr.io/jaystuart/agentpulse
```

> No Docker? Use `git clone` + Bun instead:
> ```bash
> git clone https://github.com/jaystuart/agentpulse.git && cd agentpulse
> bun install && bun run build && DISABLE_AUTH=true bun run start
> ```

### Step 2: Connect your agents

```bash
curl -sSL http://localhost:3000/setup.sh | bash
```

**Done.** Open [http://localhost:3000](http://localhost:3000) and start a new Claude Code or Codex session in another tab. It will appear on the dashboard within seconds.

## What you'll see

- **Dashboard** -- grid of all sessions with status, project name, session name, duration, and tool use count
- **Session detail** -- click a session to see a chat-style timeline with your prompts as blue bubbles and tool usage inline
- **Real-time updates** -- everything updates live via WebSocket, no refreshing needed
- **Random session names** -- each session gets a name like `brave-falcon` so you can tell them apart
- **CLAUDE.md editor** -- view and edit your agent instruction files from the dashboard
- **Setup page** -- generates hook config you can copy-paste, or use the one-liner above

## Configuration

### Authentication

By default, AgentPulse generates an API key on first start (printed in server logs). Pass it to the setup script:

```bash
curl -sSL http://localhost:3000/setup.sh | bash -s -- --key ap_YOUR_KEY
```

For local use where you don't need auth, set `DISABLE_AUTH=true` (as shown in quick start).

### Remote server

If AgentPulse runs on a different machine:

```bash
curl -sSL https://your-server.com/setup.sh | bash -s -- --url https://your-server.com --key ap_YOUR_KEY
```

### Database

- **Default:** SQLite (zero config, stored at `./data/agentpulse.db`)
- **Production:** Set `DATABASE_URL=postgresql://user:pass@host:5432/agentpulse`

### All environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | (empty = SQLite) | PostgreSQL connection string |
| `PUBLIC_URL` | `http://localhost:3000` | Public URL (used in setup script) |
| `DISABLE_AUTH` | `false` | Skip all authentication |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## What the setup script does

Running `curl -sSL .../setup.sh | bash` configures:

1. **Claude Code** -- adds HTTP hooks to `~/.claude/settings.json` for 10 events (SessionStart, Stop, PreToolUse, PostToolUse, etc.)
2. **Codex CLI** -- creates `~/.codex/hooks.json` with 5 events and enables the hooks feature flag in `config.toml`
3. **Shell** -- adds `AGENTPULSE_API_KEY` and `AGENTPULSE_URL` to your `.zshrc` or `.bashrc` (if API key provided)
4. **Verify** -- sends a test event to confirm connectivity

All hooks use `async: true` so they never slow down your agents.

## Deploy on Kubernetes

Manifests are in `deploy/k8s/`. Includes namespace, deployment, service, PVC, configmap, and Traefik IngressRoute with optional Authentik SSO.

```bash
# Edit the secret template with your DB credentials
vim deploy/k8s/01-secret-template.yaml

# Apply everything
kubectl apply -f deploy/k8s/
```

## Develop

```bash
git clone https://github.com/jaystuart/agentpulse.git
cd agentpulse
bun install
bun run dev        # starts API server + Vite dev server
```

| Command | What it does |
|---------|-------------|
| `bun run dev` | Start dev server (API + frontend with hot reload) |
| `bun run build` | Production build |
| `bun run start` | Start production server |
| `bun run check` | Lint with Biome |
| `bun run typecheck` | TypeScript type check |

## Tech stack

[Bun](https://bun.sh) + [Hono](https://hono.dev) + [React 19](https://react.dev) + [TailwindCSS](https://tailwindcss.com) + [Drizzle ORM](https://orm.drizzle.team) + [Zustand](https://zustand.docs.pmnd.rs) + SQLite/PostgreSQL

## License

MIT
