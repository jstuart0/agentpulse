# AgentPulse

[![CI](https://github.com/jstuart0/agentpulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jstuart0/agentpulse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/jstuart0/agentpulse?label=version&color=blue)](https://github.com/jstuart0/agentpulse/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![Self-hosted](https://img.shields.io/badge/self--hosted-✓-green)](https://github.com/awesome-selfhosted/awesome-selfhosted)
[![Wiki](https://img.shields.io/badge/docs-wiki-informational)](https://github.com/jstuart0/agentpulse/wiki)

**Command center for AI coding agents across all your machines.**

If you run multiple Claude Code, Codex CLI, or Copilot CLI sessions across different terminal tabs, you know the pain: *which tab is doing what?* AgentPulse gives you a live dashboard that shows every active session, what it's working on, and a scrollable chat history of everything you've said to each agent.

![AgentPulse dashboard — live view of every active Claude Code / Codex / Copilot session](src/web/assets/screenshots/agentpulse-dashboard.png)

## What AgentPulse is

AgentPulse has two major modes:

- **Observability** -- watch Claude Code, Codex, and Copilot CLI sessions in real time, with prompts, responses, progress, notes, and session history in one dashboard (Copilot CLI is observed only -- AgentPulse can't launch or steer it)
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
├─────────────────┤                        ├──────────────────────┤
│ Copilot CLI     │──── hook events ──────>│  quiet-otter: active │
│ (observed only) │                        │  "review the diff"   │
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
- **MCP server** -- let Claude Code, Codex CLI, or any MCP-compliant agent observe and orchestrate your fleet directly (list/inspect sessions, search, launch agents, steer live sessions, decide inbox items). Ships from a checkout via `agentpulse mcp serve`, or standalone via the `@agentpulse/mcp` npm package -- no checkout required. See below.
- **AI Labs (experimental)** -- optional AI layer that watches sessions, classifies health, proposes next steps with human-in-the-loop approval, plus an **Ask** command surface that lets you launch / edit / search / summarize / alert in natural language. Each feature is behind its own Labs toggle. See below.

## MCP server

AgentPulse can be driven by an external AI coding agent over the [Model Context Protocol](https://modelcontextprotocol.io): read tools (sessions, search, digest, AI intelligence) plus orchestration tools (launch agents, prompt/stop live sessions, decide HITL/inbox items), gated behind a scoped API key.

From a checkout:

```bash
agentpulse mcp install --mint my-agent          # observe-only (read-only), the safe default
agentpulse mcp install --mint my-agent --orchestrate  # adds launch/steer/decide -- read the security notes first
```

Without cloning this repo -- the standalone [`@agentpulse/mcp`](packages/agentpulse-mcp/) npm package:

```bash
npx @agentpulse/mcp install --mint my-agent
```

> **Not yet published.** The package and its release workflow (`.github/workflows/mcp-release.yml`, triggered by an `mcp-v*` tag) exist, but no version has shipped to npm yet. Until the first tag is cut, run the MCP server from a checkout instead (`agentpulse mcp serve` / `agentpulse mcp install`, above).

Either way, `install` prints ready-to-paste Claude Code and Codex CLI config. See **[docs/MCP.md](docs/MCP.md)** for the full tool catalog, client setup, and a security section covering what a `manage`-scoped key can do and why Codex CLI does not honor Claude Code's confirmation prompt.

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
curl -sSL https://your-server.example.com/setup-relay.sh | bash
```

That installs a local relay on `localhost:4000`, configures hooks automatically, and forwards events to your remote AgentPulse server. The key needs the **Hook ingest** and **Observe (read-only)** scopes — see [Option B](#advanced-remote-dashboard--local-hooks) below.

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
read -rsp 'AgentPulse API key: ' AGENTPULSE_KEY && export AGENTPULSE_KEY && echo
curl -sSL http://localhost:3000/setup.sh | bash
# Dashboard: http://localhost:3000 (local) or http://your-ip:3000 (LAN)
```

The default config requires login via the dashboard. DO NOT add `-e DISABLE_AUTH=true` on any network you do not fully control.

The `read -rsp ... && export ...` line reads the key with input hidden and hands it to the installer without it ever appearing in the command text — so it never lands in shell history or `ps`. For a scripted/non-interactive install, `AGENTPULSE_KEY=ap_YOUR_API_KEY curl -sSL http://localhost:3000/setup.sh | bash` also works, but that form is visible in shell history; `curl ... | bash -s -- --key ap_YOUR_API_KEY` works too, and is visible in both shell history and the process list — prefer the `read`/`export` form when you're at an interactive terminal.

**Option B: Remote server with local relay (recommended for k8s/VPS)**

Run AgentPulse on a server you can access from anywhere -- your phone, tablet, another machine. Check on long-running agent tasks while you're away from your desk. See if that 30-minute refactor finished, whether an agent hit an error, or what all your sessions are working on -- without being at your computer.

Multiple machines can report to the same dashboard. Run the relay setup on your MacBook, your Linux build server, a cloud VM -- every agent session across all your machines shows up in one place. One dashboard to rule them all.

One command sets up everything, no repo clone needed:

```bash
curl -sSL https://your-server.example.com/setup-relay.sh | bash
```

It asks for the API key on the terminal (input hidden), which keeps the key out of your shell history and the process list. For unattended installs, set `AGENTPULSE_KEY` or pass `--key ap_YOUR_KEY` instead; a re-run reuses the saved key. The dashboard's Setup page has this command ready to copy, with a **Mint relay key** button.

That single command:
- Checks the key with the server first, and writes nothing if it's missing a scope
- Runs the relay on your Bun if it's 1.3.12 or newer; otherwise installs that pinned, checksum-verified release privately into `~/.agentpulse/bun` (your own Bun and shell profile are left alone). Older Bun releases don't apply file modes, which the relay relies on to keep its state private.
- Installs the relay at `~/.agentpulse/relay.ts`, with its settings in `~/.agentpulse/config.json` (mode 600; the key never appears in a process list, the plist or the unit)
- Installs the Claude Code statusline at `~/.claude/statusline-agentpulse.sh` and turns it on if you don't already have a `statusLine` (otherwise it prints the line to add)
- Runs the relay as a macOS LaunchAgent or a Linux systemd user service that starts on login
- Configures Claude Code + Codex hooks to point at `localhost:4000`, and Copilot CLI hooks too if `copilot` is detected on `PATH` or `~/.copilot` exists
- Removes the obsolete `~/.agentpulse/codex-hook.sh` if an older install left one

Your agents send events to `localhost:4000` (allowed by Claude Code), the relay forwards them to your remote server. Open the dashboard from any device to monitor your agents in real time. **Re-run the same command anytime to update the relay and statusline**; the key, port and Codex-names policy from the last run are kept unless you pass new ones.

**The relay key needs Hook ingest + Observe.** The relay posts hooks (*Hook ingest*) and reads your session list to sync session names and CLAUDE.md files (*Observe (read-only)*). *Manage* is optional: it only lets the relay upload CLAUDE.md edits back to the dashboard. In **Settings → API Keys**, create the key with "Hook ingest" and "Observe (read-only)" checked; scopes can't be edited later, so mint a new key rather than changing an old one. The installer refuses a key without Observe. Pass `--allow-missing-observe` to install anyway: hooks are forwarded, but name and CLAUDE.md sync stay off.

**The server needs `PUBLIC_URL`.** `/setup-relay.sh` fills in the server's address from `PUBLIC_URL` (the first entry, if it's a comma-separated list) and never from the request's `Host` header. Without `PUBLIC_URL`, or with a `localhost` one (as in `docker-compose.yml` and `.env.example`), the server only serves the relay installer to requests from its own machine; everyone else gets a 503 saying to set it. The Kubernetes manifests already set it. The installers are built into the server, so what it serves always matches the server's version.

**Codex thread names (`--codex-names`).** The relay keeps Codex's `session_index.jsonl` and the dashboard in step, under one of two policies:

- `codex` (the default): Codex's own thread names show on the dashboard. A name you set on the dashboard is written into Codex too, and generated names fill Codex threads that have no name yet.
- `agentpulse`: dashboard names are canonical. Every Codex session's dashboard name is written into Codex, replacing its own titles, and renames made in Codex don't come back. "Use agent name" isn't offered for those sessions. Any key that can rename sessions can retitle your Codex threads this way.

Switch by re-running the installer with `--codex-names agentpulse` or `--codex-names codex` (it's saved as `codex_name_policy` in `config.json`). A Codex name that's already been replaced stays replaced after you switch back. To protect Codex from a runaway loop, the relay writes a given session's name at most 3 times an hour: a 4th rename of the same session within an hour reaches Codex up to 60 minutes late (the dashboard shows it at once, and the relay reports `push_suppressed`).

**Checking on the relay.** `curl -s http://localhost:4000/api/v1/relay/diagnostics` reports:
- `auth`: the key's scopes, and which required ones are `missing`
- `sync.codexNames` / `sync.claudeMd`: status, last error and last success (plus the active `policy` and any `suppressedIds`)
- `drift.relay` / `drift.statusline`: `ok` when your copy matches the server's, `outdated` when it doesn't (re-run the installer), `unknown` when the server couldn't be asked, and `missing` when the statusline isn't installed
- `agents.codex_cli.status`: `hooks_not_firing` when the relay has evidence Codex has been active (a foreign name change in `session_index.jsonl` since the hooks were installed) but no Codex hook has ever reached the relay -- almost always the un-trusted-hooks gap on Codex 0.145+ (run `/hooks` in Codex once), or a headless/non-interactive Codex session where nothing ever ran `/hooks` to trust them in the first place. Absent when there's no such evidence yet, so it can't false-positive on a Codex install that simply hasn't been used since setup.
- `queue`: hooks waiting to be forwarded

When something needs your attention (a key missing Observe, an outdated relay or statusline, `hooks_not_firing`), the relay writes one line to `~/.agentpulse/status`, and the statusline shows it as a dim `· agentpulse: …` hint -- e.g. `· agentpulse: codex hooks not firing — run /hooks in Codex to trust them`.

```
Manage the relay (macOS):
  Stop:    launchctl unload ~/Library/LaunchAgents/dev.agentpulse.relay.plist
  Start:   launchctl load ~/Library/LaunchAgents/dev.agentpulse.relay.plist
Manage the relay (Linux):
  Stop:    systemctl --user stop agentpulse-relay
  Start:   systemctl --user start agentpulse-relay
Both:
  Logs:    tail -f ~/.agentpulse/logs/relay.log
  Config:  cat ~/.agentpulse/config.json
```

**Reset or uninstall the relay.** Everything the relay keeps lives in `~/.agentpulse/`:

| Path | What it is |
|---|---|
| `config.json` | Server URL, API key, port, `codex_name_policy` |
| `installed.json` | When the installer last wrote the agent hooks |
| `relay.ts`, `logs/` | The relay and its logs |
| `bun/` | The relay's own Bun, if your Bun was too old or missing |
| `status` | The one-line hint the statusline shows (absent when all is well) |
| `local-sessions.json` | Sessions this relay forwarded hooks for (the only ones it syncs CLAUDE.md for) |
| `codex-pull-state.json` | Which Codex names were already sent to the dashboard |
| `codex-pushed.jsonl` | Every name the relay wrote into Codex's `session_index.jsonl` |
| `hook-queue/` | Hooks waiting to be forwarded |
| `cache/` | Claude names the statusline already sent to the dashboard |

Plus the service (`~/Library/LaunchAgents/dev.agentpulse.relay.plist` or `~/.config/systemd/user/agentpulse-relay.service`) and `~/.claude/statusline-agentpulse.sh`.

- **Reset** (clear sync state, keep the install): stop the relay, delete `status`, `local-sessions.json`, `codex-pull-state.json`, `cache/` and `hook-queue/` (unsent hooks are lost), then start it again.
- **Uninstall**: stop the relay and delete the service file, all of `~/.agentpulse/` and `~/.claude/statusline-agentpulse.sh`. Remove the `statusLine` entry and the AgentPulse hooks from `~/.claude/settings.json`, and `~/.codex/hooks.json` if nothing else uses it.
- **Keep `codex-pushed.jsonl` unless you're uninstalling.** It's how the relay tells its own writes in Codex's index from Codex's. Without it, under the `codex` policy the relay would read the names it wrote earlier as Codex's own and send them back to the dashboard as agent names.

**Option C: Kubernetes with forwardauth SSO (Authentik / Authelia / oauth2-proxy / Pomerium / Cloudflare Access)**

See `deploy/k8s/` for full manifests including Traefik IngressRoute with split auth (hooks bypass
SSO, dashboard is forwardauth-protected). The IngressRoute has separate rules so `/api/v1/hooks`
uses API key auth while everything else goes through your forwardauth IdP.

The homelab example uses Authentik; other providers work via env config — set
`FORWARDAUTH_PROVIDER` and the `FORWARDAUTH_HEADER_*` vars to match your IdP's headers.
See `deploy/k8s/FORWARDAUTH.md` for provider-specific setup instructions.

## Configuration

### Authentication

By default, AgentPulse generates an API key on first start (printed in server logs). Pass it to the setup script — prefer the hidden-prompt form, which keeps the key out of both `ps` and shell history:

```bash
read -rsp 'AgentPulse API key: ' AGENTPULSE_KEY && export AGENTPULSE_KEY && echo
curl -sSL http://localhost:3000/setup.sh | bash
```

For a scripted/non-interactive install, `AGENTPULSE_KEY=ap_YOUR_KEY curl -sSL http://localhost:3000/setup.sh | bash` also works, but is visible in shell history.

For local use where you don't need auth, set `DISABLE_AUTH=true` (as shown in quick start).

### Remote server

If AgentPulse runs on a different machine, install the relay (see [Option B](#advanced-remote-dashboard--local-hooks)); agents can only post hooks to localhost:

```bash
curl -sSL https://your-server.example.com/setup-relay.sh | bash
```

Set `PUBLIC_URL` on the server to its public address: the relay installer takes the server URL from it, never from the request.

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

1. **Claude Code** -- adds HTTP hooks to `~/.claude/settings.json` for 16 events (SessionStart, Stop, PreToolUse, PostToolUse, PermissionRequest, PreCompact, etc.), `async: true`, so they never slow down the agent.
2. **Codex CLI** -- replaces `~/.codex/hooks.json` with 12 `command`-type events (SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, Interrupt, SubagentStart, SubagentStop, PermissionRequest, PreCompact, PostCompact). An existing file is backed up first as `hooks.json.agentpulse-bak.<timestamp>`, never overwritten. Codex 0.145+ requires you to run `/hooks` inside Codex once afterward and trust the AgentPulse entries -- untrusted hooks are silently skipped. Minimum tested version: Codex CLI 0.145. The legacy `codex_hooks` line in `config.toml`, if present from an older AgentPulse setup, is no longer needed and can be deleted. **Re-running the installer with an unchanged URL/key prints "Codex hooks unchanged — no re-trust needed" and leaves `hooks.json` alone** -- you only have to run `/hooks` again when the installer actually rewrites the file (a URL or key change, or an upgrade that changes the hook shape).
3. **Copilot CLI** (detection-gated -- only when `copilot` is on `PATH` or `~/.copilot` exists) -- writes `~/.copilot/hooks/agentpulse.json` with 10 `command`-type events (sessionStart, sessionEnd, userPromptSubmitted, postToolUse, postToolUseFailure, agentStop, subagentStart, subagentStop, preCompact, errorOccurred). `preToolUse` and `permissionRequest` are deliberately not hooked -- Copilot fails closed on those events, and a synchronous AgentPulse outage would otherwise be able to block every tool call. Copilot CLI is observed only: AgentPulse can't launch or steer it.
4. **Shell** (Claude Code only) -- writes `AGENTPULSE_API_KEY` and `AGENTPULSE_URL` to a new `~/.agentpulse/env` file (mode `0600`) and adds a key-free, idempotent `[ -f ~/.agentpulse/env ] && . ~/.agentpulse/env` source line to your `.zshrc`/`.bashrc`/`.profile`. The key itself never touches the rc file. If an earlier install already left a plaintext `export AGENTPULSE_API_KEY=...` line there, the script leaves it alone but prints a warning plus the `sed` command to remove it -- it won't edit your rc file's existing content silently. Codex CLI and Copilot CLI don't get a shell/profile write at all: their hooks authenticate via `~/.agentpulse/hook-auth-header` (also `0600`).
5. **Verify** -- sends a test event to confirm connectivity

Codex and Copilot hooks are detached `command` handlers, not `async: true` HTTP hooks -- see [Codex/Copilot command hooks](#codexcopilot-command-hooks) below for why. Direct (non-relay) installs store the API key at `~/.agentpulse/hook-auth-header` (mode `0600`), never in the hooks file itself or in argv. Because they authenticate with `curl -H "@$f"` (reading the header value from a file instead of argv), **direct command hooks need curl >= 7.55** -- older curl silently sends no `Authorization` header at all instead of failing loudly. `setup-hooks.sh`/`/setup.sh` check the installed curl version and refuse to write hooks below that floor, pointing you at the relay installer instead (the relay proxies hooks through itself, so the agent-side `curl` never needs to carry the header).

Claude/Codex/Copilot event counts: 16/12/10. If you set up AgentPulse before this version, re-run the setup script to pick up the current event names and hook shape.

**No key, no write.** Before writing any hook, the installer probes `/api/v1/auth/me`. If a key was supplied (`--key` or `$AGENTPULSE_KEY`), the probe is informational and installation proceeds regardless of its result. With no key, the installer proceeds only when the probe confirms `disableAuth: true`; otherwise it refuses and writes nothing, so you never end up with hooks silently 401ing forever. Pass `--no-auth-check` to skip the probe and install anyway -- for a server that isn't reachable yet, or one that runs with auth disabled but can't be probed from here.

### Codex/Copilot command hooks

Codex CLI and Copilot CLI hooks run a small detached shell command instead of AgentPulse's own HTTP hook type (which only Claude Code supports): the command drains the hook payload to a temp file, backgrounds a `curl` POST to AgentPulse, and returns in milliseconds regardless of network conditions -- `curl`'s own `--max-time 2` is a second, independent backstop. It never writes to stdout/stderr (so it can't be mistaken for tool output) and always exits `0` (so a hook can never fail an agent's turn closed). This is why Codex hooks are `"type": "command"` (not `"http"`) and `async: false` with a `timeout` -- the detaching happens inside the command itself, not via Codex's own async hook flag, which Codex 0.145 silently drops for every event except `SessionEnd`.

## Statusline (optional)

`scripts/statusline.sh` renders your AgentPulse session name (e.g. `brave-falcon`) and context-window usage directly in Claude Code's statusline, so you can match a terminal tab to a dashboard card at a glance. It also shows the relay's hint (`· agentpulse: …`) when the relay needs attention.

**With the relay**, `setup-relay.sh` installs and updates it for you (re-run the installer to update it). **Without a relay**, copy it by hand:

```bash
chmod +x scripts/statusline.sh
cp scripts/statusline.sh ~/.claude/statusline-agentpulse.sh
```

Add to `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.claude/statusline-agentpulse.sh" }
```

**Native-name sync**: when Claude Code sets a native session name (`.session_name` in the statusline JSON, requires Claude Code with statusline session-name support), the script pushes it into AgentPulse's `displayName` via `PUT /api/v1/sessions/:id/native-name`. An ingest-scoped key is enough. This is pull-only -- the native name flows one direction, into AgentPulse -- and it never overwrites a name you've set on the dashboard: the session shows **Renamed by you**, and the agent's names don't replace it. To go back to the agent's name, use **Use agent name** on the session. The push is fire-and-forget with a 1s timeout so it can never slow down statusline rendering.

If you copied the statusline by hand before this sync behavior shipped, **re-run the `cp` step above** to pick it up.

## Manage a local install

### Supervisor exits with 403 insufficient_scope

**Symptom**: `~/.agentpulse/logs/supervisor.err.log` fills with
`403 { "error": "insufficient_scope" }` (or `401 Unauthorized`) on every
`register`/`heartbeat` attempt, and the supervisor never reaches "Registered"
in its log. This was a server-side mount-order bug (AGEN-17), not a client
misconfiguration.

**Fix**: upgrade the server. No supervisor update or config change is required
— the client already sends the correct credential; the server just needs to
answer it.

Registration itself now retries forever with backoff (starting around 5s,
capped at 5 minutes) instead of exiting on a failed attempt, so a supervisor
running this version of the client reconnects on its own the moment the
server is upgraded — **no manual restart needed**. If the loop has been
running long enough that the local log grew large, archive it (safe to do at
any time, running or not):

```bash
gzip -c ~/.agentpulse/logs/supervisor.err.log > ~/.agentpulse/logs/supervisor.err.log.$(date +%Y%m%d).gz
: > ~/.agentpulse/logs/supervisor.err.log
```

The notes below apply only if the supervisor's *process* actually stopped —
an older client that predates the retry fix and crash-looped until its
service manager gave up, or a platform (Windows) with no restart-on-failure
policy at all:

- **macOS**: `launchctl kickstart -k gui/$(id -u)/dev.agentpulse.supervisor`,
  or a full reload:
  ```bash
  launchctl bootout gui/$(id -u)/dev.agentpulse.supervisor
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.agentpulse.supervisor.plist
  ```
- **Linux**: `systemctl --user restart agentpulse-supervisor`. If
  `systemctl --user status agentpulse-supervisor` shows `start-limit-hit`,
  run `systemctl --user reset-failed` first.
- **Windows**: the scheduled task only triggers `-AtLogOn` and has no
  restart-on-failure policy — it isn't crash-looping, it's simply stopped.
  Run `Start-ScheduledTask AgentPulseSupervisor` or log back in.

If the supervisor's credential was revoked or rotated (not this bug), it
needs `/admin/supervisors/:id/rotate` — see
[`deploy/k8s/FORWARDAUTH.md`](deploy/k8s/FORWARDAUTH.md#upgrading-from-a-crash-looping-supervisor-agen-17)
for the full upgrade and ownership-audit runbook.

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
