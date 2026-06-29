# AgentPulse

[![CI](https://github.com/jstuart0/agentpulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jstuart0/agentpulse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/jstuart0/agentpulse?label=version&color=blue)](https://github.com/jstuart0/agentpulse/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![Self-hosted](https://img.shields.io/badge/self--hosted-✓-green)](https://github.com/awesome-selfhosted/awesome-selfhosted)
[![Wiki](https://img.shields.io/badge/docs-wiki-informational)](https://github.com/jstuart0/agentpulse/wiki)

**Command center for AI coding agents across all your machines.**

If you run multiple Claude Code or Codex CLI sessions across different terminal tabs, you know the pain: *which tab is doing what?* AgentPulse gives you a live dashboard that shows every active session, what it's working on, and a scrollable chat history of everything you've said to each agent.

![AgentPulse dashboard — live view of every active Claude Code / Codex session](src/web/assets/screenshots/agentpulse-dashboard.png)

## What AgentPulse is

AgentPulse has two major modes:

- **Observability** -- watch Claude Code and Codex sessions in real time, with prompts, responses, progress, notes, and session history in one dashboard
- **Orchestration** -- launch and manage sessions from AgentPulse itself with templates, supervisors, headless tasks, interactive sessions, retries, and host routing

Plus an **AI Labs** layer that's very new and explicitly experimental -- see [the Labs section below](#ai-labs-experimental).

You can run AgentPulse as:

- **observability only** -- hooks + dashboard, no supervisor/control plane
- **full local orchestration** -- hooks + dashboard + local supervisor for launch/control on the same machine
- **remote dashboard** -- relay local events to a remote AgentPulse instance

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

macOS / Linux:

This installs AgentPulse locally with Bun + SQLite, starts the web app and local supervisor as services, and configures Claude Code + Codex hooks automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.ps1 | iex
```

When it finishes, open [http://localhost:3000](http://localhost:3000) and start a new Claude Code or Codex session.

### Docker install: 1 shell line

If you prefer Docker, this starts the container, waits for health, and configures hooks:

```bash
docker run -d -p 127.0.0.1:3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true --restart unless-stopped --name agentpulse ghcr.io/jstuart0/agentpulse && until curl -fsSL http://localhost:3000/api/v1/health >/dev/null 2>&1; do sleep 1; done && curl -sSL http://localhost:3000/setup.sh | bash
```

> **Security note:** `-p 127.0.0.1:3000:3000` binds the host port to localhost only. The older `-p 3000:3000` form would publish on all host interfaces, exposing the auth-disabled server to your LAN. Use the `127.0.0.1:` prefix whenever `DISABLE_AUTH=true`.

**Done.** Open [http://localhost:3000](http://localhost:3000) and you have:
- live session observability
- local launch/control via the supervisor
- Claude Code + Codex hooks already configured

> **Why localhost?** Claude Code and Codex block HTTP hooks to remote/private IPs as a security measure. Only `localhost` / `127.0.0.1` is allowed. This keeps things simple -- one Docker container on your machine, no networking to configure. If port 3000 is taken, use any free port:
> ```bash
> docker run -d -p 127.0.0.1:4000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true -e PUBLIC_URL=http://localhost:4000 --restart unless-stopped --name agentpulse ghcr.io/jstuart0/agentpulse
> curl -sSL http://localhost:4000/setup.sh | bash
> ```

## What you'll see

![Session detail — chat-style timeline with inline tool usage](src/web/assets/screenshots/agentpulse-session.png)

- **Dashboard** -- grid of all sessions with status, project name, session name, duration, and tool use count
- **Session detail** -- click a session to see a chat-style timeline with your prompts as blue bubbles and tool usage inline
- **Projects** -- first-class projects with cwd-based session resolution; sessions stamp themselves with the right project on ingest, templates inherit project defaults (cwd, agentType, model) with per-field overrides, and a `/projects` page lets you create / edit / delete them. Saving a template under a new directory auto-creates the project for you
- **Session templates** -- save reusable Claude Code and Codex session setups, link them to a project for live-inheritance defaults, preview normalized launch specs, and route launches to the right host
- **Orchestration** -- launch headless or interactive sessions from AgentPulse, track launch status, retry, stop, and manage sessions through the local supervisor
- **Search** -- full-text across session names, prompts, plans, notes, and event payloads. SQLite uses FTS5 (BM25-ranked); Postgres uses ILIKE. Clicking an event hit jumps to the matching event in the timeline and applies a brief amber flash
- **Inbox** -- single `/inbox` view that aggregates every open approval (HITL, Ask-driven actions, alert-rule firings), stuck / risky session warnings, and recent failures. Approve / decline inline; snooze noisy items
- **Real-time updates** -- everything updates live via WebSocket, no refreshing needed
- **Random session names** -- each session gets a name like `brave-falcon` so you can tell them apart
- **CLAUDE.md editor** -- view and edit your agent instruction files from the dashboard
- **Setup page** -- generates hook config you can copy-paste, or use the one-liner above
- **AI Labs (experimental)** -- optional AI layer that watches sessions, classifies health, proposes next steps with human-in-the-loop approval, plus an **Ask** command surface that lets you launch / edit / search / summarize / alert in natural language. Each feature is behind its own Labs toggle. See below.

## AI Labs (experimental)

![Ask assistant — grounded conversational interface over live session state](src/web/assets/screenshots/agentpulse-ask.png)

> **Heads up:** the AI layer is new, shipping under explicit Labs framing. Every feature is toggleable under **Settings → Labs**. Contracts, UI, and defaults may change. Disable any toggle if it gets in your way -- nothing else in AgentPulse depends on it.

When enabled, AgentPulse can use an LLM provider you choose (Anthropic, OpenAI, OpenRouter, Google, or any OpenAI-compatible endpoint like Ollama / LM Studio / vLLM) to do the following. All AI work is **human-in-the-loop by default**: the watcher proposes, you approve or decline, and the runtime records every step as an auditable event.

### Capabilities

- **Session watcher** -- on each handoff (a `Stop` event, idle pause, plan completion, or error), the watcher reads recent events, redacts secrets via a configurable rule list, and asks the configured provider to emit one JSON decision: `continue` (with a next prompt), `ask` (route to HITL), `report` (summarize), `stop`, or `wait`. Proposals land in a durable queue so they survive server restarts.
- **Per-session config** -- provider, policy (`ask_always` / `ask_on_risk` / `auto`), daily spend cap, max continuations, optional custom system prompt, all from the session detail **AI** tab.
- **Auto-enable on Ask-initiated sessions** -- when Ask launches a session, a watcher row is attached at correlation time (enabled, `ask_on_risk` policy, default provider). Five silent-skip branches keep this from ever failing a launch: not Ask-initiated, AI inactive, user opt-out, watcher already configured, or no default provider. Settings → AI watcher has a toggle (default on) to disable.
- **Session intelligence classifier** -- deterministic heuristic flags sessions as `healthy` / `blocked` / `stuck` / `risky` / `complete_candidate` with a one-sentence reason. Shows as a chip on dashboard cards. Optionally feeds back into watcher decisions.
- **Ask command surface** -- conversational interface (web + Telegram) that turns natural language into approval cards. Every state-mutating intent goes through the same `ai_action_requests` atomic-claim approval pipeline, so concurrent web + Telegram approvals can't double-execute. Examples:
  - *"open a Claude session for agentpulse"* — queues a launch request
  - *"add a project myapp at /tmp/myapp"* — multi-turn drafting walks you through missing fields
  - *"resume brave-falcon with: refactor the auth module"* — new launch in the same cwd with the new prompt; the inbox card shows "Resume of brave-falcon" so the approver sees the parent
  - *"pin brave-falcon"* / *"add a note to slate-bear: needs review"* / *"rename auth-worker to auth-refactor"* — non-destructive direct execute, with the resolved session name embedded in the reply
  - *"stop the auth session"* / *"archive completed sessions on agentpulse"* / *"delete template auth-setup"* — destructive actions go through approval; bulk targets are previewed (cap 50, "+N more" footer)
  - *"alert me when any session on agentpulse fails"* / *"alert when the agent mentions a security concern"* — creates a project-level alert rule (constrained or freeform) with per-rule daily token budget
  - *"set up a Telegram channel called personal"* — creates a pending notification channel and returns the enrollment code
  - *"summarize session brave-falcon"* / *"why did session amber-wolf fail"* — bounded-transcript Q&A with provenance footer; cached for 15 minutes per `(session, normalized question)` and invalidated by new events
  - *"show me failed sessions"* / *"what happened today"* — read-only NL search and digest; both heuristic-only (no LLM call), so they're fast and free
- **Operator inbox** -- single `/inbox` view that aggregates open HITL requests, Ask-driven action requests, stuck / risky sessions, and recently failed proposals across every session and project. Approve / decline inline, snooze noisy failed proposals for 1h / 4h / 24h / 7d, or batch decline.
- **Project digest** -- `/digest` rolls up the last 24 hours of activity grouped by working directory: active / blocked / stuck / completed counts per repo, top plan completions, notable failures. Cached daily, manual refresh available.
- **Project alert rules** -- per-project rules that fire when sessions transition (`status_failed`, `status_completed`, `status_stuck`, `no_activity_minutes`) or when a freeform LLM-evaluated condition matches an event. Evaluation runs in `WatcherRunner`'s 60-second sweep with re-entry guard and first-run backfill (so a new `status_stuck` rule on a project with thirty already-stuck sessions doesn't notification-storm). Freeform rules carry their own daily token budget so cost stays bounded.
- **Template distillation** (API only) -- `POST /api/v1/ai/templates/distill` generates a reviewable `SessionTemplateInput` draft from a successful session, with provenance metadata.
- **Launch recommendation** (API only) -- `POST /api/v1/launches/recommendation` returns an advisory agent + model + host suggestion based on prior completions at the same cwd. The existing launch validator is still the resolver of record.
- **Risk classes + ask_on_risk** (API only) -- configurable list of risk matchers (destructive command patterns, credential references, recent test failures) that escalate a proposed `continue` to HITL regardless of policy. See `GET /api/v1/ai/risk-classes`.
- **Guarded `auto` policy** -- dispatch without HITL only when the session is managed, the supervisor is connected, no risk class matched, and the dispatch-filter accepts the prompt. Every other case still routes to HITL. Everything is auditable via `ai_continue_sent` events.
- **Spend + kill switch** -- per-user daily spend cap, per-rule cap for freeform alert rules, a global kill switch in Settings that immediately pauses all watchers, and HITL / action requests carry optional timeouts that auto-expire if ignored.
- **Local-model thinking suppression** -- when the configured provider is OpenAI-compatible (Ollama, vLLM, llama.cpp), classifier calls send `reasoning_effort: "none"` so qwen3 and similar reasoning models return clean JSON instead of burying the response in chain-of-thought. Anthropic / OpenAI / Google / OpenRouter providers receive prompts unchanged.
- **Observability** -- every wake emits a structured JSON log line prefixed with `ai_metric` (watcher run queued / completed, HITL resolution latency, classifier distribution, etc.). Pipe them into Loki / Datadog / Splunk / Elastic. Optional OTLP forwarding via `AGENTPULSE_OTEL_ENDPOINT`. A `/api/v1/ai/diagnostics` endpoint returns a point-in-time queue and flag snapshot for in-dashboard viewing.

### Enable it

AI is gated by two build-time env vars and a runtime toggle:

```bash
# Compile AI in at boot
AGENTPULSE_AI_ENABLED=true

# 32+ character random string used to encrypt provider credentials at rest.
# Required whenever AGENTPULSE_AI_ENABLED=true; AgentPulse refuses to start otherwise.
AGENTPULSE_SECRETS_KEY=<your-random-string>

# Optional: forward ai_metric log events to an OTLP-compatible collector
AGENTPULSE_OTEL_ENDPOINT=https://otel.example.com/v1/metrics
```

Once those are set, open **Settings → AI watcher**, add a provider (an API key, or a local Ollama / LM Studio URL -- no key needed), then flip **AI enabled** on. AI work does not start until you also enable the watcher per-session from the session **AI** tab.

### Labs flags

Each AI surface has its own Labs toggle under **Settings → Labs**:

| Flag | Default | Effect when off |
|---|---|---|
| `inbox` | on | Hides the `/inbox` nav link |
| `digest` | on | Hides the `/digest` nav link |
| `aiSessionTab` | on | Hides the **AI** tab in session detail |
| `intelligenceBadges` | on | Hides the health chip on dashboard session cards |
| `aiSettingsPanel` | on | Hides the entire **AI watcher** section in Settings |
| `askAssistant` | on | Disables the Ask command surface (`/ai/ask` and Telegram inbound) — falls back to read-only dashboard |
| `templateDistillation` | off | Experimental, API-only for now |
| `launchRecommendation` | off | Experimental, API-only for now |
| `riskClasses` | off | Experimental, API-only for now |
| `telegramChannel` | off | Forward HITL requests to a Telegram chat with inline Approve / Decline buttons (requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`) |

Direct URLs (`/inbox`, `/digest`, etc.) stay reachable when a flag is off -- toggling a flag hides it from the nav, not from bookmarks.

### Telegram HITL (experimental, `labs.telegramChannel`)

When enabled, the watcher can forward HITL requests to a Telegram chat with inline **Approve / Decline** buttons instead of (or in addition to) the in-app inbox. Useful for approving continuations from your phone while an agent is running somewhere else.

Enable it:

1. Create a bot with [@BotFather](https://t.me/BotFather) and get the bot token.
2. Generate a webhook secret (`openssl rand -hex 24`) and set both env vars:
   ```bash
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_WEBHOOK_SECRET=<≥24 random chars>
   ```
3. Restart AgentPulse. Open **Settings → Labs** and flip `telegramChannel` on.
4. A new **Telegram HITL channel** section appears in Settings. Click **Set webhook** once — it points Telegram at `PUBLIC_URL/api/v1/channels/telegram/webhook`.
5. Click **Generate code**. Copy the `/start <code>` shown and DM it to your bot. The bot confirms the link.
6. On any session, open the **AI** tab and assign that channel in the watcher config.

From then on, any HITL that watcher opens for that session is sent to Telegram. Tapping **Approve** routes through the same HITL-resolve path as the in-app button: the `ai_hitl_response` and `ai_continue_sent` events fire identically, just annotated with `channel: telegram`.

Safety notes:
- The bot token is instance-wide; every chat that's enrolled via `/start` shares the same bot. The chat id itself is encrypted at rest with `AGENTPULSE_SECRETS_KEY`.
- The webhook route validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` on every request, so a lucky guesser still can't forge approvals.
- An approval tapped in Telegram is cross-checked against the HITL row's `channel_id` before any resolve happens — a user who learns a HITL id cannot use a different chat to act on it.
- Delivery failures never block the in-app HITL path. If Telegram is down or slow, approve/decline still works from the dashboard or `/inbox`.

### Safety posture

- **HITL by default** -- a Claude/Codex watcher can propose, but `auto`-dispatch only runs when the session is managed and the supervisor is connected.
- **Dispatch filter** -- every prompt (watcher-proposed or user-approved) is screened against a deny-list of destructive / injection-flavored patterns before dispatch.
- **Redactor** -- transcripts are scrubbed of common secret patterns before being sent to any provider, with a dry-run preview available.
- **Prompt injection hardening** -- user transcripts are embedded in an explicit `<transcript>` UNTRUSTED block with instructions for the model to treat the contents as data.
- **Kill switch** -- flipping the single kill-switch setting pauses every watcher instantly; no per-session unwinding needed.

## Install paths

### 1. Local service with Bun + SQLite

Recommended for most OSS users. No Docker, no Kubernetes. This is the full single-machine setup: dashboard, hooks, and local supervisor/control plane.

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.ps1 | iex
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

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.sh | bash -s -- \
  --port 4000 \
  --public-url http://localhost:4000 \
  --data-dir "$HOME/.agentpulse/data"
```

Windows:

```powershell
iwr https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.ps1 -OutFile "$env:TEMP\install-local.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-local.ps1" -Port 4000 -PublicUrl http://localhost:4000 -DataDir "$HOME\.agentpulse\data"
```

If you want auth enabled from the start:

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.sh | bash -s -- \
  --disable-auth false \
  --api-key ap_your_key_here
```

Windows:

```powershell
iwr https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.ps1 -OutFile "$env:TEMP\install-local.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-local.ps1" -DisableAuth:$false -ApiKey ap_your_key_here
```

If you only want observability and do not want the local supervisor/control plane:

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.sh | bash -s -- --skip-supervisor
```

Windows:

```powershell
iwr https://raw.githubusercontent.com/jstuart0/agentpulse/main/scripts/install-local.ps1 -OutFile "$env:TEMP\install-local.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-local.ps1" -SkipSupervisor
```

That observability-only mode still gives you:

- live session monitoring
- prompts, responses, and progress in the dashboard
- notes and instruction-file editing
- remote viewing if you later use the relay path

### 2. Local Docker container

Best if you already use Docker locally.

```bash
docker run -d -p 127.0.0.1:3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true --restart unless-stopped --name agentpulse ghcr.io/jstuart0/agentpulse
curl -sSL http://localhost:3000/setup.sh | bash
```

> **Security note:** `-p 127.0.0.1:3000:3000` binds the host port to localhost only when `DISABLE_AUTH=true`. Use this form for local-only Docker; the older `-p 3000:3000` shorthand publishes on all host interfaces.

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
│                      │                   │  Forwardauth IdP (SSO)   │
│ local relay          │─── hooks ────────>│  SQLite or Postgres      │
│   forwards events    │                   │                          │
└──────────────────────┘                   │  Browse from any device  │
                                           └──────────────────────────┘
```

**Option A: Local with LAN access (auth enabled)**

> **Never combine `-p 0.0.0.0:3000:3000` with `-e DISABLE_AUTH=true`.** That combination exposes all mutation APIs to anyone on the network with zero credentials. If you need LAN access, use the auth-enabled config below. If you need `DISABLE_AUTH` for local convenience, use `-p 127.0.0.1:3000:3000` so the port is not published on network interfaces.

Run AgentPulse on your machine, bind to `0.0.0.0` so other devices on your LAN can view the dashboard. Auth is required — create a local admin via the bootstrap env vars:

```bash
docker run -d -p 0.0.0.0:3000:3000 -v agentpulse-data:/app/data \
  -e HOST=0.0.0.0 \
  -e AGENTPULSE_LOCAL_ADMIN_USERNAME=admin \
  -e AGENTPULSE_LOCAL_ADMIN_PASSWORD=<strong-password> \
  --restart unless-stopped --name agentpulse ghcr.io/jstuart0/agentpulse
curl -sSL http://localhost:3000/setup.sh | bash -s -- --key ap_YOUR_API_KEY
# Dashboard: http://localhost:3000 (local) or http://your-ip:3000 (LAN)
```

The default config requires login via the dashboard. DO NOT add `-e DISABLE_AUTH=true` on any network you do not fully control.

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

**Option C: Kubernetes with forwardauth SSO (Authentik / Authelia / oauth2-proxy / Pomerium / Cloudflare Access)**

See `deploy/k8s/` for full manifests including Traefik IngressRoute with split auth (hooks bypass
SSO, dashboard is forwardauth-protected). The IngressRoute has separate rules so `/api/v1/hooks`
uses API key auth while everything else goes through your forwardauth IdP.

The homelab example uses Authentik; other providers work via env config — set
`FORWARDAUTH_PROVIDER` and the `FORWARDAUTH_HEADER_*` vars to match your IdP's headers.
See `deploy/k8s/FORWARDAUTH.md` for provider-specific setup instructions.

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

**SQLite** (stored at `./data/agentpulse.db`) is the default. Zero-config, single-file, handles home-lab and small-team scale comfortably.

**PostgreSQL** is supported as of v0.4.0 for production and multi-replica deployments. Set `DATABASE_URL=postgres://user:password@host:5432/dbname` and AgentPulse uses Postgres instead of SQLite. See [Production / multi-replica with Postgres](#production--multi-replica-with-postgres) below.

Limitations in this release: vector search (`event_embeddings`) remains SQLite-only (pgvector port is a follow-up); search on Postgres uses ILIKE rather than tsvector (adequate for moderate event volumes; tsvector migration is a follow-up for high-volume deployments). There is no SQLite→Postgres data migrator — Postgres installs start fresh.

### Security headers

AgentPulse ships a `Content-Security-Policy-Report-Only` header (as of 0.3.0). This surfaces CSP violations in `POST /api/v1/csp-report` (structured JSON log) without blocking anything. Enforcement mode (`Content-Security-Policy`) will follow in a future release once reports are clean in production.

### All environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `127.0.0.1` | Bind address. The published Docker image overrides this to `0.0.0.0` via `ENV HOST=0.0.0.0`; bare `bun run start` binds localhost only. |
| `PUBLIC_URL` | `http://localhost:3000` | Public URL (used in setup script) |
| `DATA_DIR` | `./data` | Base directory for local SQLite storage |
| `SQLITE_PATH` | `${DATA_DIR}/agentpulse.db` | Override the SQLite database file path |
| `DISABLE_AUTH` | `false` | Skip all authentication |
| `AGENTPULSE_ALLOW_SIGNUP` | `false` | Allow open signup on an empty instance. Set `true` to enable the first-run signup flow. Once any user exists, signup is blocked regardless. |
| `FORWARDAUTH_TRUST_SECRET` | | Shared secret for the forwardauth header trust gate (k8s SSO deployments). Generate with `openssl rand -hex 32`. See `deploy/k8s/FORWARDAUTH.md`. Legacy alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` accepted for one release. |
| `FORWARDAUTH_PROVIDER` | `authentik` | Forwardauth provider label. Appears in the dashboard UI and `/auth/me` response. Only `"authentik"` triggers the Authentik sign-out URL; other values render the provider name and return `signOutUrl: null`. |
| `FORWARDAUTH_HEADER_USERNAME` | `X-Authentik-Username` | Header carrying the authenticated username from the upstream IdP. |
| `FORWARDAUTH_HEADER_EMAIL` | `X-Authentik-Email` | Header carrying the authenticated email address. |
| `FORWARDAUTH_HEADER_GROUPS` | `X-Authentik-Groups` | Header carrying group memberships. |
| `FORWARDAUTH_HEADER_NAME` | `X-Authentik-Name` | Header carrying the user's display name. |
| `FORWARDAUTH_HEADER_UID` | `X-Authentik-Uid` | Header carrying the unique user identifier. |
| `FORWARDAUTH_HEADER_VERIFY` | `X-Authentik-Verify` | Header used to carry the trust secret from Traefik to AgentPulse. |
| `FORWARDAUTH_HEADER_STRIP_PREFIX` | `X-Authentik-` | Prefix of IdP identity headers stripped before forwardauth runs. |
| `AGENTPULSE_SSO_SESSION_DURATION_MS` | `28800000` (8 h) | Lifetime in milliseconds of the `ap_session` cookie minted by the forwardauth session bridge. Local-auth sessions use a separate 30-day TTL and are unaffected. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AGENTPULSE_TELEMETRY` | `on` | Set `off` to disable anonymous telemetry |
| `DO_NOT_TRACK` | | Set `1` to disable telemetry (standard) |
| `AGENTPULSE_TELEMETRY_MODE` | inferred | Telemetry install class override: `self_hosted_real`, `production`, `dev`, `test`, or `ci` |
| `AGENTPULSE_TELEMETRY_TEST` | | Set `1` to force this install to report as `test` |
| `AGENTPULSE_AI_ENABLED` | `false` | Compile the AI Labs layer in at boot. Off = zero AI services, routes, or UI (non-AI install footprint is identical to pre-AI). |
| `AGENTPULSE_SECRETS_KEY` | | Required when `AGENTPULSE_AI_ENABLED=true`. 32+ random chars; encrypts provider credentials at rest (AES-256-GCM). |
| `AGENTPULSE_OTEL_ENDPOINT` | | Optional OTLP metrics endpoint. When set, `ai_metric` log events are also forwarded as OTLP. |
| `DATABASE_URL` | `""` (SQLite) | Postgres connection string. When set to a `postgres://...` URL, AgentPulse uses PostgreSQL instead of SQLite. Example: `postgres://agentpulse:password@host:5432/agentpulse?sslmode=require`. Leave unset or empty for SQLite. |
| `AGENTPULSE_PG_POOL_MAX` | `10` | Maximum Postgres connection pool size. Integer in [1, 100]. Tune based on your Postgres server's `max_connections` and replica count. |
| `AGENTPULSE_LEGACY_INIT` | (unset) | SQLite existing-install migration behaviour. Set to `"false"` to force a fresh Drizzle migrate on an existing SQLite install (opt-in, non-destructive if schema is already current). Unset keeps the legacy `initializeDatabase()` path for existing SQLite installs. |
| `TELEGRAM_BOT_TOKEN` | | Instance-wide Telegram bot token (get one from @BotFather). Required to enable the Telegram HITL channel. |
| `TELEGRAM_WEBHOOK_SECRET` | | Shared secret Telegram echoes back on every webhook callback. ≥24 random chars. Required when `TELEGRAM_BOT_TOKEN` is set. |

Telemetry classification defaults:

- `CI=true` reports as `ci`
- prerelease/dev builds report as `dev`
- stable production builds report as `self_hosted_real`
- set `AGENTPULSE_TELEMETRY_MODE=test` or `AGENTPULSE_TELEMETRY_TEST=1` for local/test deployments so they do not pollute real-world usage counts

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

### Windows

```powershell
Get-ScheduledTask AgentPulseLocal
Get-ScheduledTask AgentPulseSupervisor
Get-Content "$HOME\.agentpulse\logs\agentpulse.out.log" -Wait
Get-Content "$HOME\.agentpulse\logs\supervisor.out.log" -Wait
```

### Manual start

```bash
cd ~/.agentpulse/app
export $(cat .env.local | xargs)
bun run start
```

## Deploy on Kubernetes

Manifests are in `deploy/k8s/`. Includes namespace, deployment, service, PVC, configmap, and Traefik IngressRoute with optional forwardauth SSO (Authentik by default; configurable for Authelia, oauth2-proxy, Pomerium, Cloudflare Access via env vars).

```bash
# Create a real Secret out of band (see deploy/k8s/01-secret-template.yaml for the shape)
# then apply the Kustomize base:
kubectl apply -k deploy/k8s/
```

## Production / multi-replica with Postgres

For deployments that need multi-replica scale-out or prefer a managed Postgres instance over a local SQLite file:

```bash
# 1. Verify kubectl context
kubectl config current-context
# Expected: your production cluster context

# 2. Create database and user (on your Postgres host)
psql -h your-postgres-host -U psadmin \
  -c "CREATE USER agentpulse WITH PASSWORD '<password>';"
psql -h your-postgres-host -U psadmin \
  -c "CREATE DATABASE agentpulse OWNER agentpulse ENCODING 'UTF8' \
      LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"

# 3. Fill in the credentials file (gitignored — do NOT commit)
cp deploy/overlays/postgres/secret-patch.yaml.example \
   deploy/overlays/postgres/secret-patch.yaml
# Edit secret-patch.yaml: set DATABASE_URL to the full connection string
# e.g. postgres://agentpulse:<pw>@host:5432/agentpulse?sslmode=require
kubectl apply -f deploy/overlays/postgres/secret-patch.yaml -n agentpulse

# 4. Render and apply
kubectl kustomize deploy/overlays/postgres/  # verify output first
kubectl apply -k deploy/overlays/postgres/
```

AgentPulse runs Drizzle migrations on boot using a dedicated single-connection client. A session-level `pg_advisory_lock` serializes migration across replicas booting simultaneously, making rolling deploys safe without coordination overhead.

Connection pool size defaults to 10. Tune it via `AGENTPULSE_PG_POOL_MAX` based on your Postgres `max_connections` setting and replica count.

The Postgres overlay removes the SQLite backup sidecar (no longer needed). The SQLite PVC is left in place until you confirm data has been migrated or is no longer needed, then delete it manually.

See `deploy/overlays/postgres/README.md` for the full pre-flight checklist and rollback notes.

## Develop

```bash
git clone https://github.com/jstuart0/agentpulse.git
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

[Bun](https://bun.sh) + [Hono](https://hono.dev) + [React 19](https://react.dev) + [TailwindCSS](https://tailwindcss.com) + [Drizzle ORM](https://orm.drizzle.team) + [Zustand](https://zustand.docs.pmnd.rs) + SQLite (default) / PostgreSQL

## Community & Contributing

- 📘 **[Wiki](https://github.com/jstuart0/agentpulse/wiki)** — Getting Started, Architecture, AI Watcher deep-dive, Ask assistant, Telegram setup, Deployment, FAQ, Roadmap.
- 🧰 **[Good first issues](https://github.com/jstuart0/agentpulse/labels/good%20first%20issue)** — 10 starter tickets with file paths + acceptance criteria: new LLM adapters (Mistral, Cohere), new notification channels (Slack, Discord), a11y polish, diagnostic CLI, CI workflow, more test coverage.
- 🐛 **[Issues](https://github.com/jstuart0/agentpulse/issues)** — bug reports + feature requests welcome.
- 📜 **[CHANGELOG](CHANGELOG.md)** — every release, with the reason behind each change.
- 🤝 **[Contributing guide](https://github.com/jstuart0/agentpulse/wiki/Contributing)** — dev setup, repo layout, conventions, gotchas.

## License

MIT
