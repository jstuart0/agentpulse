# AgentPulse

![AgentPulse](src/web/assets/agentpulse-social.jpg)

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

## Quick start

### Easiest local install: 1 command

This installs AgentPulse locally with Bun + SQLite, starts the web app and local supervisor as services, and configures Claude Code + Codex hooks automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/jaystuart/agentpulse/main/scripts/install-local.sh | bash
```

When it finishes, open [http://localhost:3000](http://localhost:3000) and start a new Claude Code or Codex session.

### Docker install: 1 shell line

If you prefer Docker, this starts the container, waits for health, and configures hooks:

```bash
docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true --restart unless-stopped --name agentpulse ghcr.io/jaystuart/agentpulse && until curl -fsSL http://localhost:3000/api/v1/health >/dev/null 2>&1; do sleep 1; done && curl -sSL http://localhost:3000/setup.sh | bash
```

**Done.** Open [http://localhost:3000](http://localhost:3000) and you have:
- live session observability
- local launch/control via the supervisor
- Claude Code + Codex hooks already configured

> **Why localhost?** Claude Code and Codex block HTTP hooks to remote/private IPs as a security measure. Only `localhost` / `127.0.0.1` is allowed. This keeps things simple -- one Docker container on your machine, no networking to configure. If port 3000 is taken, use any free port:
> ```bash
> docker run -d -p 4000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true -e PUBLIC_URL=http://localhost:4000 --restart unless-stopped --name agentpulse ghcr.io/jaystuart/agentpulse
> curl -sSL http://localhost:4000/setup.sh | bash
> ```

## What you'll see

- **Dashboard** -- grid of all sessions with status, project name, session name, duration, and tool use count
- **Session detail** -- click a session to see a chat-style timeline with your prompts as blue bubbles and tool usage inline
- **Session templates** -- save reusable Claude Code and Codex session setups, then preview normalized launch specs and command guidance before launch automation exists
- **Real-time updates** -- everything updates live via WebSocket, no refreshing needed
- **Random session names** -- each session gets a name like `brave-falcon` so you can tell them apart
- **CLAUDE.md editor** -- view and edit your agent instruction files from the dashboard
- **Setup page** -- generates hook config you can copy-paste, or use the one-liner above

## Install paths

### 1. Local service with Bun + SQLite

Recommended for most OSS users. No Docker, no Postgres, no Kubernetes. This is the full single-machine setup: dashboard, hooks, and local supervisor/control plane.

```bash
curl -fsSL https://raw.githubusercontent.com/jaystuart/agentpulse/main/scripts/install-local.sh | bash
```

What it does:

- installs Bun if needed
- clones AgentPulse to `~/.agentpulse/app`
- builds the app
- stores SQLite data in `~/.agentpulse/data`
- starts AgentPulse as a local service
  - macOS: `launchd`
  - Linux: `systemd --user` when available
- writes `~/.agentpulse/supervisor.json`
- starts the local supervisor service on the same machine
- configures Claude Code + Codex hooks automatically when auth is disabled or an API key is provided
- gives you local live-session control without extra manual setup on the same machine

Useful options:

```bash
curl -fsSL https://raw.githubusercontent.com/jaystuart/agentpulse/main/scripts/install-local.sh | bash -s -- \
  --port 4000 \
  --public-url http://localhost:4000 \
  --data-dir "$HOME/.agentpulse/data"
```

If you want auth enabled from the start:

```bash
curl -fsSL https://raw.githubusercontent.com/jaystuart/agentpulse/main/scripts/install-local.sh | bash -s -- \
  --disable-auth false \
  --api-key ap_your_key_here
```

If you only want observability and do not want the local supervisor/control plane:

```bash
curl -fsSL https://agentpulse.xmojo.net/install-local.sh | bash -s -- --skip-supervisor
```

### 2. Local Docker container

Best if you already use Docker locally.

```bash
docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true --restart unless-stopped --name agentpulse ghcr.io/jaystuart/agentpulse
curl -sSL http://localhost:3000/setup.sh | bash
```

### 3. Remote dashboard + local hooks

Best if you want to monitor sessions from other devices while your agents still run on your laptop/workstation.

Use the relay installer:

```bash
curl -sSL https://your-server.com/setup-relay.sh | bash -s -- --key ap_YOUR_KEY
```

That installs a local relay on `localhost:4000`, configures hooks automatically, and forwards events to your remote AgentPulse server.

## Advanced: Remote dashboard + local hooks

If you want to access AgentPulse from any device on your network (phone, tablet, another machine) while still collecting events from your local agents:

**Architecture:**
```
Your Mac                                    Your server / k8s cluster
┌──────────────────────┐                   ┌──────────────────────────┐
│ Claude Code / Codex  │                   │  AgentPulse (remote)     │
│   hooks → localhost  │                   │  https://pulse.mynet.com │
│                      │                   │  Authentik SSO           │
│ AgentPulse (local)   │── shared DB ─────>│  PostgreSQL              │
│   localhost:3000     │   (optional)      │                          │
│   collects events    │                   │  Browse from any device  │
└──────────────────────┘                   └──────────────────────────┘
```

**Option A: Local-only with port access from other devices**

Run AgentPulse on your machine, bind to `0.0.0.0` so other devices on your LAN can view the dashboard:

```bash
docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true -e HOST=0.0.0.0 --restart unless-stopped --name agentpulse ghcr.io/jaystuart/agentpulse
curl -sSL http://localhost:3000/setup.sh | bash
# Dashboard: http://localhost:3000 (local) or http://your-ip:3000 (LAN)
```

**Option B: Remote server with local relay (recommended for k8s/VPS)**

Run AgentPulse on a server you can access from anywhere -- your phone, tablet, another machine. Check on long-running agent tasks while you're away from your desk. See if that 30-minute refactor finished, whether an agent hit an error, or what all your sessions are working on -- without being at your computer.

Multiple machines can report to the same dashboard. Run the relay setup on your MacBook, your Linux build server, a cloud VM -- every agent session across all your machines shows up in one place. One dashboard to rule them all.

One command sets up everything, no repo clone needed:

```bash
curl -sSL https://your-server.com/setup-relay.sh | bash -s -- --key ap_YOUR_KEY
```

That single command:
- Installs Bun if you don't have it
- Installs a tiny relay at `~/.agentpulse/relay.ts`
- Creates a macOS LaunchAgent (or Linux systemd service) that auto-starts on login
- Configures Claude Code + Codex hooks to point at `localhost:4000`
- Starts the relay immediately

Your agents send events to `localhost:4000` (allowed by Claude Code), the relay forwards them to your remote server. Open the dashboard from any device to monitor your agents in real time.

```
Manage the relay:
  Stop:    launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist
  Start:   launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist
  Logs:    tail -f ~/.agentpulse/logs/relay.log
  Config:  cat ~/.agentpulse/config.json
```

**Option C: Local collector + remote dashboard (shared database)**

Run a local instance for hook collection and a remote instance for the dashboard, both pointing at the same PostgreSQL database:

```bash
# On your machine (hooks point here)
docker run -d -p 3000:3000 -e DISABLE_AUTH=true -e DATABASE_URL=postgresql://user:pass@db-host:5432/agentpulse --restart unless-stopped --name agentpulse ghcr.io/jaystuart/agentpulse
curl -sSL http://localhost:3000/setup.sh | bash

# On your server (dashboard accessed from anywhere)
# Deploy with k8s manifests in deploy/k8s/ pointing at the same DATABASE_URL
kubectl apply -f deploy/k8s/
```

Both instances read/write the same database, so the remote dashboard shows everything the local collector receives.

**Option C: Kubernetes with Authentik SSO**

See `deploy/k8s/` for full manifests including Traefik IngressRoute with split auth (hooks bypass Authentik, dashboard is SSO-protected). The IngressRoute has separate rules so `/api/v1/hooks` uses API key auth while everything else goes through Authentik forwardAuth.

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
| `DATA_DIR` | `./data` | Base directory for local SQLite storage |
| `SQLITE_PATH` | `${DATA_DIR}/agentpulse.db` | Override the SQLite database file path |
| `DISABLE_AUTH` | `false` | Skip all authentication |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AGENTPULSE_TELEMETRY` | `on` | Set `off` to disable anonymous telemetry |
| `DO_NOT_TRACK` | | Set `1` to disable telemetry (standard) |

## What the setup script does

Running `curl -sSL .../setup.sh | bash` configures:

1. **Claude Code** -- adds HTTP hooks to `~/.claude/settings.json` for 10 events (SessionStart, Stop, PreToolUse, PostToolUse, etc.)
2. **Codex CLI** -- creates `~/.codex/hooks.json` with 5 events and enables the hooks feature flag in `config.toml`
3. **Shell** -- adds `AGENTPULSE_API_KEY` and `AGENTPULSE_URL` to your `.zshrc` or `.bashrc` (if API key provided)
4. **Verify** -- sends a test event to confirm connectivity

All hooks use `async: true` so they never slow down your agents.

## Manage a local install

### macOS

```bash
launchctl unload ~/Library/LaunchAgents/dev.agentpulse.local.plist
launchctl load ~/Library/LaunchAgents/dev.agentpulse.local.plist
tail -f ~/.agentpulse/logs/agentpulse.out.log
tail -f ~/.agentpulse/logs/supervisor.out.log
```

### Linux

```bash
systemctl --user restart agentpulse
journalctl --user -u agentpulse -f
```

### Manual start

```bash
cd ~/.agentpulse/app
export $(cat .env.local | xargs)
bun run start
```

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
