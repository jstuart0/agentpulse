# AGENTS.md - AgentPulse

AgentPulse is the command center for AI coding agents across all your machines. It monitors, orchestrates, and manages Claude Code and Codex CLI sessions from a single dashboard with chat-style prompt history, session notes, templates, managed launches, and remote access from any device. GitHub Copilot CLI is also observed (dedicated hooks, badge, "Observed only" hint) but can't be launched or steered — see `LAUNCHABLE_AGENT_TYPES` below.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS
- **State:** 8 Zustand stores
- **Database:** SQLite (default) and PostgreSQL (production / multi-replica, v0.4.0+) via Drizzle ORM — set `DATABASE_URL=postgres://...` to opt into Postgres
- **Real-time:** WebSocket (native Bun) + 3s polling fallback
- **MCP:** Model Context Protocol server in `packages/agentpulse-mcp/` (`agentpulse mcp serve|install`); see `docs/MCP.md`
- **Linting:** Biome

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Start dev server (API + Vite)
bun run dev:server       # Start API server only
bun run dev:web          # Start Vite frontend only
bun run dev:supervisor   # Start local supervisor only (watch mode)
bun run build            # Production build
bun run start            # Start production server
bun run check            # Run Biome linter
bun run check:fix        # Run Biome linter with auto-fix
bun run check:architecture  # Run all architecture guard scripts
bun run typecheck        # TypeScript type checking
bun run test             # Run test suite (bun test)
bun run test:watch       # Run tests in watch mode
```

## Project Structure

```
src/
  server/
    routes/       ~24 route files: ingest.ts, sessions.ts, settings.ts, auth.ts,
                  launches.ts, templates.ts, projects.ts, search.ts, setup.ts,
                  ask.ts, channels.ts, labs.ts, supervisors.ts, health.ts,
                  internal.ts, csp-report.ts, ingest-counters.ts,
                  agent-type-query.ts, ai-gates.ts, ai-inbox.ts,
                  ai-intelligence.ts, ai-providers.ts, ai-status.ts, ai-watcher.ts
    services/     ~22 service files + subdirs: ai/, ask/, channels/, projects/,
                  search/, templates/, util/, workspace/,
                  event-processor.ts, event-dedup.ts, event-dto.ts,
                  session-tracker.ts, session-ownership.ts, name-generator.ts,
                  telemetry.ts, settings-service.ts, labs-service.ts,
                  launch-dispatch.ts, launch-validator.ts, notifier.ts, ...
    db/           Drizzle schema (SQLite + Postgres, per-dialect), client, migrations
    auth/         API key auth (ingest/observe/manage scopes), forwardauth header trust middleware
    ws/           WebSocket pub/sub
  web/
    pages/        AskPage, DashboardPage, DigestPage, HostsPage, InboxPage,
                  LaunchDetailPage, LoginPage, ProjectsPage, SearchPage,
                  SessionDetailPage, SettingsPage, SetupPage, TemplatesPage
    components/   SessionCard, SessionGrid, StatusBadge, Layout, PlanTracker,
                  IntelligenceBadge, MarkdownContent, TopBar, WsStatusChip,
                  + subdirs: inbox/, session-detail/, settings/, templates/
    stores/       8 stores: connection-store, event-store, labs-store,
                  projects-store, session-store, tabs-store, ui-prefs-store,
                  user-store
    hooks/        useWebSocket, useSessions
    lib/          api.ts (single API client), utils.ts (parseDate(), etc.)
  shared/         Shared types (session-state.ts, etc.)
  supervisor/     Local supervisor process (launch/control plane)
packages/
  agentpulse-mcp/ Standalone MCP server package (publishes to npm as
                  @agentpulse/mcp; not yet published — run from a checkout via
                  `agentpulse mcp serve`/`install` until it is)
deploy/k8s/       Kubernetes manifests (namespace, deployment, service,
                  ingressroute, middleware, networkpolicy, backup PVC, etc.)
deploy/overlays/postgres/  Kustomize overlay for Postgres-backed deployments
scripts/          setup-relay.sh, setup-hooks.sh, relay.ts, install-local.sh,
                  install-local.ps1, build-and-push.sh, statusline.sh,
                  check-installers.ts, smoke-parsers.ts, ai-live-test.ts
snippets/         CLAUDE.md/AGENTS.md snippets for semantic status reporting
telemetry-worker/ Cloudflare Worker for anonymous telemetry collection
```

## Architecture

### Event Flow
```
Agent (Claude Code / Codex / Copilot CLI)
  → HTTP hook (Claude Code) or detached command hook (Codex, Copilot) — async, never blocks agent
  → localhost relay (if remote setup)
  → POST /api/v1/hooks
  → Event Processor (detect agent type, upsert session, store event)
  → DB + WebSocket broadcast
  → Dashboard UI (real-time updates)
```

### Auth (two modes)
- `DISABLE_AUTH=true` — No auth, all endpoints open (default for local use)
- Auth enabled — API key for hooks, forwardauth SSO for dashboard (k8s deployment).
  Works with any forwardauth-capable IdP (Authentik by default, or Authelia,
  oauth2-proxy, Pomerium, Cloudflare Access via env config).
  `FORWARDAUTH_TRUST_SECRET` required for SSO production deployments (legacy
  alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` accepted until v0.7.0); see
  `deploy/k8s/FORWARDAUTH.md`.
  - API keys carry explicit scopes: `ingest` (hooks), `observe` (read-only,
    provably secret-free at the REST boundary), `manage` (full operator
    control). See `src/server/auth/route-scope-policy.ts`.

### AI gate rejection codes

- **404 / `{ error: "ai_disabled" }`** — AI not compiled in or disabled in settings
- **409 / `{ error: "ai_paused" }`** — Kill switch active; watchers paused

Do NOT use `503 / ai_kill_switch_active` — that code was never shipped.

## Key Conventions

- Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- Hook ingestion always returns 200 (rate-limited/oversize drops are silent; counters in /health)
- Hook deliveries are deduplicated by durable identity (`events.dedup_key`), not content comparison — repeated identical tool calls are all stored
- An unrecognized `agent_type`/`agentType` filter on `/sessions`, `/templates`, `/search` returns `400 { error: "invalid_agent_type", value, allowed }` instead of silently matching zero rows
- SQLite datetime: `"YYYY-MM-DD HH:MM:SS"` (no T/Z) — use `parseDate()` from `src/web/lib/utils.ts`
- Session names: adjective-noun pairs from `name-generator.ts`
- DB migrations: Drizzle (baselines in `drizzle/sqlite/` and `drizzle/postgres/`); existing SQLite installs use the legacy `initializeDatabase()` path unless `AGENTPULSE_LEGACY_INIT=false`
- `isWorking` toggles on UserPromptSubmit/PreToolUse (true) and Stop (false)
- Timeline events are filtered **client-side** in session detail UI (not server-side)
- Supervisor writes are ownership-checked (`session-ownership.ts`) — a supervisor acting on a session it doesn't own gets `403 { error: "session_not_owned" }`
- Three observed agent types: `claude_code`, `codex_cli`, `copilot_cli`. `LAUNCHABLE_AGENT_TYPES` (`src/shared/constants.ts`) is `["claude_code", "codex_cli"]` — Copilot CLI is observe-only, use `isLaunchable()` to check. Hook-event lists (Claude/Codex/Copilot: 16/12/10 events) must stay in parity across setup scripts and `SetupPage.tsx`; `bun run check:hook-event-parity` and `check:agent-type-parity` (both chained into `check:architecture`) enforce it.

## Core API Endpoints

**Public:**
- `GET /api/v1/health` — Health check (503 until DB ready)
- `GET /api/v1/ready` — Readiness probe (503 during graceful drain)
- `POST /api/v1/csp-report` — Browser CSP violation report receiver (unauthenticated)
- `GET /setup.sh` — Self-contained hook setup script

**Hook ingestion:**
- `POST /api/v1/hooks` — Receive hook events (always 200)
- `POST /api/v1/hooks/status` — Receive semantic status updates

**Internal (loopback-only):**
- `POST /api/v1/internal/drain` — Initiate graceful drain (blocked externally by Traefik)

**Sessions:**
- `GET /api/v1/sessions` — List sessions
- `GET /api/v1/sessions/stats` — Dashboard KPI stats
- `GET /api/v1/sessions/:id` — Session detail with timeline
- `PUT /api/v1/sessions/:id/notes` — Save notes
- `PUT /api/v1/sessions/:id/rename` — Rename
- `PUT /api/v1/sessions/:id/native-name` — Pull-only sync of Claude Code's native session name (statusline)
- `PUT /api/v1/sessions/:id/pin` — Toggle pin
- `PUT /api/v1/sessions/:id/archive` — Archive
- `DELETE /api/v1/sessions/:id` — Delete session + events
- `GET /api/v1/sessions/:id/claude-md` — Get CLAUDE.md content
- `PUT /api/v1/sessions/:id/claude-md` — Save CLAUDE.md content

**Projects:**
- `GET /api/v1/projects` — List projects, full detail (`manage`-scoped only)
- `GET /api/v1/projects/summary` — Observe-safe project list (id/name/defaults, redacted `githubRepoUrl`)

**Settings:**
- `GET /api/v1/settings` — Get all settings
- `PUT /api/v1/settings` — Update setting (403 for protected keys: `{ error: "key_not_user_settable", key }`)

**Other:**
- `GET /api/v1/search?kinds=session&q=` — Full-text search (FTS5 on SQLite, ILIKE on Postgres)
- `GET/POST/DELETE /api/v1/api-keys` — Manage API keys (scopes: `ingest`, `observe`, `manage`)
- `WS /api/v1/ws` — Real-time event stream

**MCP:** `agentpulse mcp serve` exposes this API over the Model Context Protocol for external agents (Claude Code, Codex CLI). `list_sessions` accepts `agent_type: "copilot_cli"` for filtering; orchestration tools (launch/template) accept only `claude_code`/`codex_cli`. See `docs/MCP.md` for the full tool catalog and scope model.

## OSS Hygiene

- Never commit real domains, IPs, API keys, hostnames, or private infrastructure identifiers
- Replace private values with safe placeholders before commit
- `deploy/k8s-homelab/` (gitignored overlay) is the correct place for real deployment values
