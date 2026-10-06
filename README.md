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

- **Dashboard** -- grid of all sessions with status, project name, session name, duration, and tool use count. Each session is in exactly one operational state: **Waiting** (the agent finished a turn, or has an outstanding permission prompt, and is waiting on you -- "Mark as seen" clears it), **Error** (the session failed and hasn't been dismissed -- "Dismiss error" clears it), **Working** (the agent is actively working right now), or **Idle** (nothing is waiting and the agent isn't working). Status cards above the grid filter by state; a "What do these states mean?" popover repeats this explanation in the UI
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
  - *"which sessions are waiting"* / *"what needs attention"* — answered from the same operational state as the dashboard's status cards (waiting, or error for needs attention). The project digest and the bulk actions (*"archive completed sessions…"*) still use the lifecycle states (active, completed, failed): they have no waiting or needs-attention filter.
  - **Limits:** at most two Ask turns run at once, across the web and Telegram together (`AGENTPULSE_ASK_MAX_CONCURRENT`). A turn that finds both slots taken waits up to 30 seconds in a short line, then is refused: the web answers `503` with `Retry-After`, the streaming web reply sends an error frame, and Telegram replies that Ask is busy. A message over 8,000 characters is refused (`400 message_too_long` on the web, a reply on Telegram), pinned `sessionIds` must be at most 20 strings of at most 128 characters (`400 invalid_session_ids`), and a request body over 256 KiB is `413`. When vector search is on, semantic matching covers the newest 50,000 vectors of the active model within a 4-second budget; older events are still found by keyword search (see `AGENTPULSE_VECTOR_SCAN_MAX_ROWS` and `AGENTPULSE_VECTOR_SCAN_MAX_MS`).
- **Operator inbox** -- single `/inbox` view that aggregates open HITL requests, Ask-driven action requests, stuck / risky sessions, and recently failed proposals across every session and project. Approve / decline inline, snooze noisy failed proposals for 1h / 4h / 24h / 7d, or batch decline.
- **Project digest** -- `/digest` rolls up the last 24 hours of activity grouped by working directory: active / blocked / stuck / completed counts per repo, top plan completions, notable failures. Cached daily, manual refresh available.
- **Project alert rules** -- per-project rules that fire when sessions transition (`status_failed`, `status_completed`, `status_stuck`, `no_activity_minutes`) or when a freeform LLM-evaluated condition matches an event. Evaluation runs in `WatcherRunner`'s 60-second sweep with re-entry guard and first-run backfill (so a new `status_stuck` rule on a project with thirty already-stuck sessions doesn't notification-storm). Freeform rules carry their own daily token budget so cost stays bounded.
- **Template distillation** (API only) -- `POST /api/v1/ai/templates/distill` generates a reviewable `SessionTemplateInput` draft from a successful session, with provenance metadata.
- **Launch recommendation** (API only) -- `POST /api/v1/launches/recommendation` returns an advisory agent + model + host suggestion based on prior completions at the same cwd. The existing launch validator is still the resolver of record.
- **Risk classes + ask_on_risk** (API only) -- configurable list of risk matchers (destructive command patterns, credential references, recent test failures) that escalate a proposed `continue` to HITL regardless of policy. See `GET /api/v1/ai/risk-classes`.
- **Guarded `auto` policy** -- dispatch without HITL only when the session is managed, the supervisor is connected, no risk class matched, and the dispatch-filter accepts the prompt. Every other case still routes to HITL. Everything is auditable via `ai_continue_sent` events.
- **Spend + kill switch** -- per-user daily spend cap, per-rule cap for freeform alert rules, a global kill switch in Settings that immediately pauses all watchers, and HITL / action requests carry optional timeouts that auto-expire if ignored.
- **Session summary** (off by default) -- an on-demand, checkable summary of any session: outcome, what changed, what was validated, what is unfinished, a handoff to paste into another agent. See [Session summary](#session-summary-experimental-labssessionsummary).
- **Summary spend** -- money set aside for a session summary in progress counts toward "Today's spend" until the summary settles at its real cost; after a hard crash it stays counted until the server's local midnight. A call that cannot have been billed (the connection never opened, or the provider answered with a 4xx) costs nothing; a call whose outcome is unknown (a timeout, a gateway cut-off, a connection dropped mid-call) is charged its worst case, and the daily cap is checked against the worst case of the prompt actually sent. Three such failures in ten minutes pause new summary requests (they answer busy) until a call succeeds or five minutes pass.
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
| `sessionSummary` | off | Hides the **Summary** tab and the Summary entry points; the routes answer `session_summary_disabled`. Nothing is sent to your provider until you ask for a summary. See [Session summary](#session-summary-experimental-labssessionsummary) |
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
- The webhook route validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` on every request (a constant-time comparison, done before the body is read), so a lucky guesser still can't forge approvals. A body over 1 MiB is refused with `413`.
- A Telegram question whose turn fails gets a fixed reply; the error detail goes to the server log, not to the chat. Some launch set-up failures (creating or cloning a project from an Ask message) still include the underlying error message in the reply; see the Known limitations in `CHANGELOG.md`.
- An approval tapped in Telegram is cross-checked against the HITL row's `channel_id` before any resolve happens — a user who learns a HITL id cannot use a different chat to act on it.
- Delivery failures never block the in-app HITL path. If Telegram is down or slow, approve/decline still works from the dashboard or `/inbox`.

### Session summary (experimental, `labs.sessionSummary`)

A **Summary** tab on each session that summarizes it on request: what it set out to do, what changed, what was checked and how that ended, what is unfinished, the next actions, and a handoff you can copy into another agent. It is never automatic: nothing is sent to your provider until you press **Summarize this session**.

**Turn it on.** AI enabled with a default provider (see [Enable it](#enable-it)), then **Settings → Labs → Session summary**, or press **Turn on** on a session's **AI** tab. In team mode only an admin can change Labs flags.

**What is sent to the provider.** The session's prompts, agent replies, notes, current task, plan summary, commands and file paths. Known secret patterns (API keys, tokens, passwords in URLs, private keys, auth headers, and the rest of the watcher's redaction rules) are masked before anything leaves. Command output is sent only for a test or build that failed, and then only its first and last 300 characters after masking. A command that reads a credential file is withheld whole. Session summaries use the built-in redaction rules only; rules you add in Settings are used by the redaction preview, not by summaries.

**What it costs.** Each summary is one provider call, plus one repair call if the first answer is unusable. The most it can cost, and the most with a repair, is shown under the button before you press it, and counts against the same daily AI cap as the watcher and Ask (500 cents by default). A new summary of the same session can start 30 seconds after the last attempt began. A free or local provider records no cost.

**How it is checked.** The model cites numbered events from the session. The server checks each cited event exists and what kind it is and how it ended, drops the ones that don't, and marks a claim with no confirming citation "Agent's claim only". A test or build the session ran that failed cannot be shown as passed (the result becomes "unknown", marked adjusted), nor can a pass stand when an edit came after it. A summary whose text looks like it carries instructions for whoever pastes it shows a "check before pasting" notice and relabels the copy buttons.

**Limits.**

- "Observed" means a hook reported the event happened. It does not mean anyone checked a claim.
- A cited event is checked for existence, kind and result, not for whether it proves the sentence that cites it.
- "Agent's claim only" marks what nothing recorded confirms. Absence of that mark is not proof.
- The check-before-pasting notice is a heuristic tripwire, not a control. Read a handoff before you paste it into an agent. It does not catch: commands in inline code whose verb is outside its list (`find -delete`, `tar`, `ln`), writes done by redirects, interpreter scripts and `source`/`eval`, bare hosts whose top-level domain isn't on its list, prose instructions with no code in them, loopback GET requests that have side effects, `git` pointed at a plain remote name, and PowerShell syntax (not parsed).
- A summary is a snapshot. When the session moves on, a notice says how many events came after it; **Update** makes a new one.
- Summaries are on demand. Nothing summarizes in the background.
- Spend is one shared daily cap. A failure that may have been billed (a timeout, a gateway cut-off, a dropped connection) is charged the per-call maximum. Three of those in ten minutes make that caller's new requests answer busy for 5 minutes, then longer on each repeat. Once such charges reach a quarter of the daily cap, summaries are refused for everyone until local midnight, so one member who can make the provider time out can switch summaries off for everyone for the rest of the day.
- The request limit (6 a minute per caller), the two generation slots, the breaker and the daily ceiling live in each server process; with more than one replica they loosen, and a restart clears them.
- A summary is visible to everyone who can read the session. Team mode shares reads, so that is everyone on the instance with dashboard access. Observe-only API keys can't read it.
- Stored summaries are deleted by the event-retention pass when retention is on; otherwise they stay until the session is deleted.
- The Windows / PowerShell hook paths were never executed in this project's tests, so a summary of a Windows session depends on hook code that hasn't been tested here.

### Safety posture

- **HITL by default** -- a Claude/Codex watcher can propose, but `auto`-dispatch only runs when the session is managed and the supervisor is connected.
- **Dispatch filter** -- every prompt (watcher-proposed or user-approved) is screened against a deny-list of destructive / injection-flavored patterns before dispatch.
- **Redactor** -- the watcher's transcripts and session summaries are scrubbed of common secret patterns before being sent to your provider, with a dry-run preview available. Ask and Q&A do not redact.
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
- writes `~/.agentpulse/supervisor.json` (mode `0600`, holds the supervisor
  credential — see AGEN-21 in the changelog)
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
( ap_key=$(if [ -t 0 ]; then s=$(stty -g 2>/dev/null) && stty -echo 2>/dev/null || { echo "Can't hide the key while you type it, so it won't be asked for here. Use the scripted form in the docs instead." >&2; exit 1; }; trap 'echo >&2; exit 130' INT TERM HUP; trap 'stty "$s" 2>/dev/null' EXIT; fi; printf 'AgentPulse API key: ' >&2; IFS= read -r k; if [ -t 0 ]; then echo >&2; fi; printf %s "$k") && case "$ap_key" in '') echo "No API key entered; nothing was installed." >&2; false;; *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) echo "The API key can only contain letters, digits, '.', '_' and '-'; nothing was installed." >&2; false;; *) export AGENTPULSE_KEY="$ap_key"; curl -sSL http://localhost:3000/setup.sh | bash;; esac )
# Dashboard: http://localhost:3000 (local) or http://your-ip:3000 (LAN)
```

The default config requires login via the dashboard. DO NOT add `-e DISABLE_AUTH=true` on any network you do not fully control.

The prompt reads the key with input hidden and hands it to the installer without it ever appearing in the command text — so it never lands in shell history or `ps`. It hides input with `stty -echo` rather than `read -s`, which dash — the `sh` on Debian and Ubuntu — doesn't have; it also works in bash and zsh. The whole snippet runs in a subshell, so the key never stays in your shell or its environment, and Ctrl-C at the prompt cancels it and restores your terminal. It refuses to ask if it can't hide what you type, and a blank answer or a key with characters outside letters, digits, `.`, `_` and `-` installs nothing and says why, rather than running curl unauthenticated. For a scripted/non-interactive install, `AGENTPULSE_KEY=ap_YOUR_API_KEY curl -sSL http://localhost:3000/setup.sh | bash` also works, but that form is visible in shell history; `curl ... | bash -s -- --key ap_YOUR_API_KEY` works too, and is visible in both shell history and the process list — prefer the `read` form when you're at an interactive terminal.

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
| `cache/` | A checksum of each Claude name the statusline already sent to the dashboard (not the name itself) |

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
( ap_key=$(if [ -t 0 ]; then s=$(stty -g 2>/dev/null) && stty -echo 2>/dev/null || { echo "Can't hide the key while you type it, so it won't be asked for here. Use the scripted form in the docs instead." >&2; exit 1; }; trap 'echo >&2; exit 130' INT TERM HUP; trap 'stty "$s" 2>/dev/null' EXIT; fi; printf 'AgentPulse API key: ' >&2; IFS= read -r k; if [ -t 0 ]; then echo >&2; fi; printf %s "$k") && case "$ap_key" in '') echo "No API key entered; nothing was installed." >&2; false;; *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) echo "The API key can only contain letters, digits, '.', '_' and '-'; nothing was installed." >&2; false;; *) export AGENTPULSE_KEY="$ap_key"; curl -sSL http://localhost:3000/setup.sh | bash;; esac )
```

Works in dash, bash and zsh. For a scripted/non-interactive install, `AGENTPULSE_KEY=ap_YOUR_KEY curl -sSL http://localhost:3000/setup.sh | bash` also works, but is visible in shell history.

For local use where you don't need auth, set `DISABLE_AUTH=true` (as shown in quick start).

### Remote server

If AgentPulse runs on a different machine, install the relay (see [Option B](#advanced-remote-dashboard--local-hooks)). It runs on that machine, keeps your key out of agent config, queues events on disk when the server is unreachable, and applies your [exclude rules](#excluding-directories-from-agentpulse) before anything is sent:

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
| `AGENTPULSE_MODE` | (unset) | `solo` or `team`. Fixes the instance mode and stops the UI changing it; any other value stops boot. Unset: the mode is chosen in Settings (solo until an admin switches). See [Teams](#teams). |
| `AGENTPULSE_ADMIN_SSO_SUBJECTS` | (unset) | Comma-separated identity-provider subjects (stable uids, never usernames) that are admins. Needs the uid header configured; see `deploy/k8s/FORWARDAUTH.md`. |
| `AGENTPULSE_SESSION_CREATE_LIMIT` | `120` | Team mode: new sessions one person (or one key with no owner) may create per minute. A positive whole number. Counted in memory, per server process. |
| `AGENTPULSE_SKIP` | (unset) | Set in an agent's environment to `1`, `true`, `yes` or `on` to keep that run from being reported. A client-side setting; see [Excluding directories](#excluding-directories-from-agentpulse). |
| `AGENTPULSE_CODEX_RESUME_WINDOW_HOURS` | `24` | Supervisor, Codex observer: a Codex rollout file written to within this many hours is followed wherever it sits under `~/.codex/sessions`, so a session resumed from an older date directory is picked up (within a few minutes of its first write). A file seen this way for the first time is followed from its first line written in the last 15 minutes (or from its end if no recent timestamp is found in its last 256 KiB); older history is not replayed. `0` turns it off. The exclude rules apply as for any other rollout file. |
| `AGENTPULSE_RELAY_LOCAL_URL` | `http://localhost:4000` | Where `agentpulse exclude check` looks for the local relay. |
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
| `AGENTPULSE_VECTOR_SCAN_MAX_ROWS` | `50000` | Vector search only (SQLite). Most vectors one Ask semantic scan reads, newest first. Range 1,000 to 5,000,000; out-of-range values are clamped. |
| `AGENTPULSE_VECTOR_SCAN_MAX_MS` | `4000` | Longest one Ask semantic scan runs, in milliseconds, pacing included. Range 250 to 60,000. |
| `AGENTPULSE_VECTOR_SCAN_CPU_SHARE` | `0.3` | Share of CPU all concurrent semantic scans together may use. Range 0.05 to 1; `1` turns pacing off. |
| `AGENTPULSE_ASK_MAX_CONCURRENT` | `2` | Ask turns that may run at once, web and Telegram together, per process. Range 1 to 8. |
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

## Teams

AgentPulse runs in one of two modes. **Solo** is the default and behaves as it always has: every signed-in user sees and can do everything, and nothing about ownership is enforced. **Team** adds people, admins and owner checks on top. Switching never deletes anything; sessions, keys and hosts keep the owner they were recorded with, and solo mode simply hides the labels.

Team mode needs authentication. It can't be turned on while `DISABLE_AUTH=true`, and the server refuses to boot that way.

### Switching

- **From Settings.** An admin opens **Settings → Team → Set up team mode**. Every API key that has no owner and can manage needs a decision first: keep it as an admin service key, give it an owner, or revoke it. The decisions and the switch happen together or not at all. **Switch back to solo mode** is in the same place and asks again next time.
- **From the environment.** `AGENTPULSE_MODE=team` (or `solo`) fixes the mode and the UI can't change it. A value that is neither is refused at boot. With `team`, the server also refuses to start unless someone can sign in as an admin (`AGENTPULSE_LOCAL_ADMIN_USERNAME` with `AGENTPULSE_LOCAL_ADMIN_PASSWORD`, an existing admin, or a subject in `AGENTPULSE_ADMIN_SSO_SUBJECTS`). Keys with no owner and manage scope are not asked about in this case: they act as members until an admin keeps or assigns them in Settings, so automation that used one for settings or key management gets `403 admin_required`. Boot logs a warning naming such keys by prefix.
- **SSO-only installs** can't switch from the UI until `AGENTPULSE_ADMIN_SSO_SUBJECTS` lists at least one admin and the server has restarted. List stable uids (your identity provider's uid header, see `deploy/k8s/FORWARDAUTH.md`), never display usernames: an identity provider can hand a username to someone else.

### What team mode is not

**Everyone who can sign in sees every session.** Team mode attributes work to people. It does not make anything private.

- Any member can open any session, and read its prompts, events, notes, names, hosts and launch outcomes. The owner filter in the dashboard is a view, not access control.
- Any member can prompt, stop or retry any managed session, and can launch on any host, including hosts other members enrolled. A launch carries its prompt and environment to that host's supervisor. A launch that names no host runs on the first host that can run it, which may be another member's machine: name your own host to keep the prompt and environment on your machines.
- A host's owner (their supervisor, and anyone holding that host's credential) can read, write to and close sessions launched on that host by anyone, because the agent runs on their machine. Owning a host controls who may rotate or revoke it, not who may launch on it.
- Live updates go to every signed-in browser, whatever its owner filter says. Every observe-scoped API key reads everything too.
- Open tabs keep session names and directories in the browser's local storage, per signed-in user.

What team mode does enforce: deleting, archiving, renaming, pinning a session, and editing its notes or stored CLAUDE.md, need the session's owner or an admin (a session nobody owns is open to any signed-in member). Revoking a key needs its owner or an admin. Rotating or revoking a host needs its owner or an admin. Marking a session as seen counts for its owner or an admin. Every setting except the theme, plus the AI, Telegram, labs and search administration routes and scratch-workspace cleanup, is admin-only. User management and the mode switch need a signed-in human admin; an API key can never do them, whoever owns it.

### Who owns what

- **A session's owner is whoever's API key reported it**, decided when the session is first created. This is attribution by key possession, not authentication of a person: anyone holding your key reports as you. The first write wins; later events never change the owner. A session launched from the dashboard is owned by whoever launched it. An admin can change an owner on the session page.
- **Use your own key on each machine.** A key you mint is owned by you, and so are the sessions it reports. A key minted by a member (on the Setup page or in Settings), or by a key that member owns (`agentpulse mcp install --mint`), belongs to that member.
- **Service keys** have no owner (shared automation, CI). An admin marks one when minting it. A service key that can manage and is kept as an **admin service key** acts as an admin in team mode; any other service key acts as a member. Sessions reported only by a service key show as "Service key"; sessions nobody owns show as "Unassigned". An admin can hand every unassigned session to one person.
- In team mode, once an owned session exists, hook events for it from a key that belongs to someone else are dropped (still answered `200`) and counted. Events are accepted from the owner's keys, the key the session was first reported with, keys owned by the owner of the host the session runs on, and, for a launched session whose host has no recorded key yet, a service key.

### After switching to team: hosts

Every host (supervisor) that existed before the switch has no owner. Hook events for a session launched from the dashboard on a host are accepted only from a key owned by that host's owner, or from a service key. So **give each existing host an owner** (Hosts page → Change owner, or `PATCH /api/v1/admin/supervisors/:id`), or keep the key that machine reports with as a service key. Until then, hook events for dashboard-launched sessions from that host are ignored. Enrollment tokens with no recorded creator are deactivated by the switch; enroll again as a signed-in member.

### Offboarding

Disable the person in AgentPulse (**Settings → Team**, the person's row). Removing them at the identity provider is not enough: their API keys and any host they own keep working until they are disabled here. Disabling ends their sign-ins, deactivates their API keys and enrollment tokens, revokes the hosts they own, and closes their open dashboard connections. The dialog shows an "Also revoke their N hosts" box (on by default, and only when the person owns hosts); unchecked, the hosts stay enrolled, still owned by the disabled person, and can still run launches. The API takes the same choice as `revokeHosts: false`. Their sessions stay, still owned by them. Re-enabling does not restore revoked keys or hosts. The last active admin can't be disabled or demoted, nor can an admin whose role comes from `AGENTPULSE_ADMIN_SSO_SUBJECTS`.

### People

- SSO users get an account the first time they sign in. They are members unless their uid is in `AGENTPULSE_ADMIN_SSO_SUBJECTS`.
- An admin can add a local account (**Settings → Team**). AgentPulse generates a password, shows it once and makes the person replace it at first sign-in; until they do, their API keys get `403 password_change_required` everywhere except hook ingestion, which keeps accepting events (this is true on solo installs too). An admin can reset a local account's password the same way; that ends the account's sign-ins.
- Changing a password is limited to 5 failed current-password attempts per account per 15 minutes.

### The dashboard in team mode

- **Mine | Everyone** switch. It opens on Mine if you own any session, otherwise Everyone, and remembers what you pick.
- **Owner** select: Everyone, you, each person, service keys, unassigned.
- **Group by** Project, User or Agent.
- Status cards, the tabs (Active, Completed, Archived and All, which leaves archived sessions out) and their badges all follow the owner you've selected, and are counted by the server, so the numbers stay correct beyond the rows loaded. On a very large install the status counts come from a bounded scan: when the response says `truncated` (the dashboard notes it on the status cards) they are approximate.
- The **Inbox** is not narrowed by Mine | Everyone or the Owner select: it lists items across every session.
- **Show scratch workspaces** now applies to every count, not just the grid; while it is off, the number of scratch sessions left out is shown beside it. This applies in solo mode too.
- Desktop notifications in team mode fire only for your own sessions, whichever filter is on. Solo mode notifies for every session.
- **Which machine.** A session shows "on <machine>" when a supervisor launched it, or when its relay or the Codex observer reported a machine name. That name is the sender's own claim and is shown to everyone who can see the session; AgentPulse never uses it to decide who may do what. Hooks posted straight to the server, without a relay, show no machine.

### Limits

In team mode one person (or, for a key with no owner, one key) may create at most 120 new sessions a minute (`AGENTPULSE_SESSION_CREATE_LIMIT`). The rest are dropped with the usual `200` and counted as `sessionCreationLimited` on `/health`. Minting API keys is limited to 10 a minute per person. Solo mode has no creation limit.

With `DISABLE_AUTH=true`, live updates connect only from a loopback address or from the configured `PUBLIC_URL` (a protection against pages that resolve to your machine). Reach such an instance on another address and the dashboard falls back to polling until you set `PUBLIC_URL`.

### Counters on `/health`

`/health` is public. In team mode its counters include `foreignKeyDropped` (events dropped because the key belonged to someone else), `ingestKeyBound`, `sessionCreationLimited` and `skipHeaderDropped` (deliveries skipped by `AGENTPULSE_SKIP`). They are aggregate counts, but they do reveal that team mode, and exclusion, are in use.

## Excluding directories from AgentPulse

Members and solo users alike can stop sessions in chosen directories from being reported. Rules live on each machine, in `~/.agentpulse/exclude`, one absolute directory per line (`~/` is expanded; blank lines and lines starting with `#` are ignored). A rule covers the directory and everything under it. No wildcards, no `.` or `..` segments, at most 500 rules.

```bash
agentpulse exclude add ~/scratch     # validates, then writes the file
agentpulse exclude list
agentpulse exclude check [dir]       # is this directory excluded, and who enforces it
```

`exclude check` exits 0 for excluded, 1 for not excluded and 2 when the rules file is invalid.

**The server never learns what is excluded.** The rules stay on the machine. They are not visible to admins or other members. The one thing a host's supervisor reports is a flag that its exclude file (or its saved exclude state) is invalid.

### Fails closed

If the rules file can't be trusted, whatever applies the rules sends nothing. The file is invalid when: it or `~/.agentpulse` is not owned by you, or is writable by group or others; the file is a symlink or hardlink or not a regular file; it can't be read; it's over 64 KiB; or a line isn't a plain absolute path (relative path, wildcard, `.`/`..` segment, NUL byte, more than 500 rules). The message names the line and the fix. Recreating the file with `agentpulse exclude add` is always safe.

### Skipping one run

`AGENTPULSE_SKIP=1` (also `true`, `yes`, `on`, any case) in the environment of an agent stops that run's events from being reported. Claude Code's hook configuration forwards the variable as an `X-AgentPulse-Skip` header; the server answers `200` and drops those deliveries. The other senders read the variable directly, as the table says.

### Who applies the rules

| Sender | What applies your rules |
|---|---|
| Codex CLI, Copilot CLI | The hook command checks the rules before anything is sent. If the rules file can't be read or trusted, nothing is sent. `AGENTPULSE_SKIP=1` skips one run. |
| Claude Code through the relay | The relay on that machine checks the rules before anything is stored or passed on, and sends nothing while the rules file is invalid. `AGENTPULSE_SKIP=1` skips one run. |
| Sessions AgentPulse launches, and the Codex observer | The supervisor on that machine applies the rules. A launch into an excluded directory is refused. The supervisor doesn't see `AGENTPULSE_SKIP`; the directory rules cover these. |
| Claude Code straight to the server | Path rules are **not applied**, and a broken rules file doesn't stop it. Use the relay, or set `AGENTPULSE_SKIP=1`. With the skip variable the request still reaches the server, which discards it. |

An old relay or supervisor doesn't apply rules at all. Update or reinstall it; `agentpulse exclude check` reports a running relay that predates exclude rules as not enforcing.

### How to notice

- `agentpulse exclude check` prints a per-sender verdict.
- While the file is invalid, the hooks write an empty marker file, `~/.agentpulse/exclude.invalid`.
- The statusline (where installed) says `not reported (excluded)`, `not reported (AGENTPULSE_SKIP)`, or that the rules are invalid and which senders are paused.
- The Hosts page shows a warning on a host whose supervisor reports its exclude file as invalid.
- A machine that only runs Codex or Copilot in direct mode has none of the last two: use the marker file and `exclude check`, and run it after any hand edit of the file.

### Limits and gaps

- Rules apply to **new** events. A session reported before a rule existed stays at its last state on the dashboard until the periodic sweep ends it: after 5 minutes without activity it goes idle, and after 30 it's completed; a session still marked as working is cleared after 60 minutes of silence. Delete it yourself to remove it sooner. A managed session whose directory becomes excluded is reported once as completed and the dashboard stops tracking it while the agent may still be running.
- A skipped request has already left the machine; it is only kept out of the database. The skip header and the rules are honoured by the client, and the server can't enforce them against a modified client.
- A launch the host refuses because the directory is excluded reads the same as a refusal for a directory outside the host's trusted roots, and the reason goes only to the host's own log. The wording of such a refusal still differs depending on whether the host has an exclude file at all, and the server's own request-time trusted-roots check is unchanged. So a member who can launch on a host, and watches for refusals, can learn which directories under that host's trusted roots are excluded. A host whose exclude file is invalid refuses every launch.
- The Hosts page shows every member a warning on a host whose supervisor reports its exclude file (or its saved exclude state) as invalid. That is the only thing about exclusion the server keeps, and it says nothing about which directories.
- Codex asks you to re-approve its hooks after you re-run setup, because the hook command changed.
- Transcripts the agents keep on disk are not touched.
- **Windows (PowerShell) support is written but has never been executed on Windows.** Don't rely on it.

## What the setup script does

Running `curl -sSL .../setup.sh | bash` configures:

1. **Claude Code** -- adds HTTP hooks to `~/.claude/settings.json` for 16 events (SessionStart, Stop, PreToolUse, PostToolUse, PermissionRequest, PreCompact, etc.), `async: true`, so they never slow down the agent. A supplied key is embedded directly in the header (`Authorization: Bearer ap_...`), and the file is tightened to mode `0600` (a no-follow write; a symlinked `settings.json` is refused, not written through) -- see "User scope vs. project scope" below for why.
2. **Codex CLI** -- replaces `~/.codex/hooks.json` with 12 `command`-type events (SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, Stop, Interrupt, SubagentStart, SubagentStop, PermissionRequest, PreCompact, PostCompact). An existing file is backed up first as `hooks.json.agentpulse-bak.<timestamp>`, never overwritten. Codex 0.145+ requires you to run `/hooks` inside Codex once afterward and trust the AgentPulse entries -- untrusted hooks are silently skipped. Minimum tested version: Codex CLI 0.145. The legacy `codex_hooks` line in `config.toml`, if present from an older AgentPulse setup, is no longer needed and can be deleted. **Re-running the installer with an unchanged URL/key prints "Codex hooks unchanged — no re-trust needed" and leaves `hooks.json` alone** -- you only have to run `/hooks` again when the installer actually rewrites the file (a URL or key change, or an upgrade that changes the hook shape).
3. **Copilot CLI** (detection-gated -- only when `copilot` is on `PATH` or `~/.copilot` exists) -- writes `~/.copilot/hooks/agentpulse.json` with 10 `command`-type events (sessionStart, sessionEnd, userPromptSubmitted, postToolUse, postToolUseFailure, agentStop, subagentStart, subagentStop, preCompact, errorOccurred). `preToolUse` and `permissionRequest` are deliberately not hooked -- Copilot fails closed on those events, and a synchronous AgentPulse outage would otherwise be able to block every tool call. Copilot CLI is observed only: AgentPulse can't launch or steer it.
4. **Shell** (Claude Code only) -- writes `AGENTPULSE_API_KEY` and `AGENTPULSE_URL` to a new `~/.agentpulse/env` file (mode `0600`) and adds a key-free, idempotent `[ -f ~/.agentpulse/env ] && . ~/.agentpulse/env` source line to your `.zshrc`/`.bashrc`/`.profile`. The key itself never touches the rc file. If an earlier install already left a plaintext `export AGENTPULSE_API_KEY=...` line there, the script leaves it alone but prints a warning plus the `sed` command to remove it -- it won't edit your rc file's existing content silently. Codex CLI and Copilot CLI don't get a shell/profile write at all: their hooks authenticate via `~/.agentpulse/hook-auth-header` (also `0600`).
5. **Verify** -- sends a test event to confirm connectivity

Codex and Copilot hooks are detached `command` handlers, not `async: true` HTTP hooks -- see [Codex/Copilot command hooks](#codexcopilot-command-hooks) below for why. Direct (non-relay) installs store the API key at `~/.agentpulse/hook-auth-header` (mode `0600`), never in the hooks file itself or in argv. Because they authenticate with `curl -H "@$f"` (reading the header value from a file instead of argv), **direct command hooks need curl >= 7.55** -- older curl silently sends no `Authorization` header at all instead of failing loudly. `setup-hooks.sh`/`/setup.sh` check the installed curl version and refuse to write hooks below that floor, pointing you at the relay installer instead (the relay proxies hooks through itself, so the agent-side `curl` never needs to carry the header).

Claude/Codex/Copilot event counts: 16/12/10. If you set up AgentPulse before this version, re-run the setup script to pick up the current event names and hook shape.

**No key, no write.** Before writing any hook, the installer probes `/api/v1/auth/me`. If a key was supplied (`--key` or `$AGENTPULSE_KEY`), the probe is informational and installation proceeds regardless of its result. With no key, the installer proceeds only when the probe confirms `disableAuth: true`; otherwise it refuses and writes nothing, so you never end up with hooks silently 401ing forever. Pass `--no-auth-check` to skip the probe and install anyway -- for a server that isn't reachable yet, or one that runs with auth disabled but can't be probed from here.

### Claude Code: user scope vs. project scope

Claude Code's native HTTP hook expands `$AGENTPULSE_API_KEY` from **its own process environment** -- not the shell that launched it. A Claude Code window opened from the Dock, a file manager, or an IDE (or one left running from before you last ran the installer) never sees a value exported into `~/.agentpulse/env` afterward, so the env-var form of the header 401s silently there: the hook fires, gets rejected, and nothing tells you.

- **User scope** (`~/.claude/settings.json` -- the default for `/setup.sh`, `agentpulse setup`, and `setup-hooks.sh`'s default `--scope global`): trades that reliability gap away by embedding the literal key directly in the header. This is made acceptable by tightening the file to mode `0600` (owner-read/write only, never world-readable) with a no-follow write (a symlinked `settings.json` is refused rather than written through) -- the same standard already applied to `~/.agentpulse/hook-auth-header` and `~/.agentpulse/env`. Merging into an existing `settings.json` preserves every other key already in it.
- **Project scope** (`setup-hooks.sh --scope project`, writing a repo's own `.claude/settings.json`): never gets a literal key -- that file can be committed to source control. It keeps the `$AGENTPULSE_API_KEY` / `allowedEnvVars` form unconditionally, and the installer prints a reminder to fully restart Claude Code afterward (a GUI- or IDE-launched instance may not see a shell-exported env var at all).

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

**The name lookup is small**: the statusline asks the relay for the name only (`GET /api/v1/sessions/<id>?fields=displayName`, tens of bytes however long the session is; the relay remembers it for five seconds), and shows the first characters of the session id if a lookup ever fails. This needs the server at 0.7.2 or later; re-run the installer (or the `cp` step) to update the statusline and relay.

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

### A host registered but doesn't appear on the Hosts page

**Symptom**: the supervisor's own log shows a successful registration
(`[supervisor] Registered <hostName> (<id>)`), but the host never shows up
on `/hosts` in the dashboard.

**Likely causes, in order of likelihood**:

1. **Multiple SQLite server instances behind a load balancer.** AgentPulse
   on SQLite only supports a single running server instance — see
   [Production / multi-replica with Postgres](#production--multi-replica-with-postgres).
   If the server was deployed with more than one replica/task (common on
   ECS, Kubernetes with `replicas > 1`, or `docker compose --scale`), each
   instance has its own independent local database file; a registration
   landing on instance A is invisible from instance B. The dashboard now
   detects this automatically and shows a persistent warning banner when
   it's talking to more than one database. To check by hand: open
   `GET /api/v1/health` in your browser a few times in a row (or across a
   page refresh) and compare `instance.dbFingerprint` — if it changes
   between requests (and isn't just a one-time value from a server
   restart), you have more than one instance. `instance.dialect` tells you
   `sqlite` vs `postgres`.
2. **The list request itself failed.** The Hosts page used to render
   silently as "No hosts are registered yet" even when
   `GET /api/v1/admin/supervisors` actually failed (an expired session, an
   under-scoped API key, a network blip). It now shows a distinct error
   state with the status code and server message (e.g. "Couldn't load
   hosts: 403 insufficient_scope") and a Retry button — if you still see
   this on a current version, that error message is the actual cause.
3. **Version/URL mismatch.** Confirm the supervisor's configured
   `serverUrl` points at the exact host:port your browser hits, and that
   both are on a version that includes the supervisor agent-routing fix
   (AGEN-17, v0.6.0+) — see the 403 section above.

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

Rolling updates are safe for **migrations** only. Several limits live in each replica's memory and reset on restart, so with N replicas they are N times looser, and they briefly double during a rolling deploy: the hook rate limiter, the per-owner session-creation limit (`AGENTPULSE_SESSION_CREATE_LIMIT`), the API-key mint limit, the password-change failure limit, and the stats scan queue and in-flight coalescing. The instance mode and every owner are read from the database on each request, so those are consistent across replicas. Until process-local state is externalised, run a single replica.

Connection pool size defaults to 10. Tune it via `AGENTPULSE_PG_POOL_MAX` based on your Postgres `max_connections` setting and replica count.

The Postgres overlay removes the SQLite backup sidecar (no longer needed). The SQLite PVC is left in place until you confirm data has been migrated or is no longer needed, then delete it manually.

See `deploy/overlays/postgres/README.md` for the full pre-flight checklist and rollback notes.

**Verifying you're not accidentally running split SQLite instances**: `GET
/api/v1/health` includes `instance: { dbFingerprint, dialect }` — a short,
non-reversible fingerprint of the backing database (never the raw
installation id). On Postgres every replica shares one database, so this
is always one stable value. On SQLite, if you poll `/health` across
requests (or just watch the dashboard, which now does this for you and
raises a banner) and see more than one `dbFingerprint`, you have more than
one SQLite instance running — see the Hosts-page troubleshooting entry
above.

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
