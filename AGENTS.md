# AGENTS.md - AgentPulse

AgentPulse is the command center for AI coding agents across all your machines. It monitors, orchestrates, and manages Claude Code and Codex CLI sessions from a single dashboard with chat-style prompt history, session notes, templates, managed launches, and remote access from any device.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS
- **State:** 8 Zustand stores
- **Database:** SQLite (Drizzle ORM); PostgreSQL not implemented
- **Real-time:** WebSocket (native Bun) + 3s polling fallback
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
    routes/       ~26 route files: ingest.ts, sessions.ts, settings.ts, auth.ts,
                  launches.ts, templates.ts, projects.ts, search.ts, setup.ts,
                  ask.ts, channels.ts, labs.ts, supervisors.ts, health.ts,
                  internal.ts, csp-report.ts, ingest-counters.ts,
                  ai-gates.ts, ai-inbox.ts, ai-intelligence.ts,
                  ai-providers.ts, ai-status.ts, ai-watcher.ts
    services/     ~30 service files + subdirs: ai/, ask/, channels/, projects/,
                  search/, templates/, util/, workspace/,
                  event-processor.ts, session-tracker.ts, name-generator.ts,
                  telemetry.ts, settings-service.ts, labs-service.ts,
                  launch-dispatch.ts, launch-validator.ts, notifier.ts, ...
    db/           Drizzle schema, client, append-only migrations
    auth/         API key auth, Authentik header trust middleware
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
    lib/          api.ts (single API client), parseDate.ts
  shared/         Shared types (session-state.ts, etc.)
  supervisor/     Local supervisor process (launch/control plane)
deploy/k8s/       Kubernetes manifests (namespace, deployment, service,
                  ingressroute, middleware, networkpolicy, backup PVC, etc.)
scripts/          setup-relay.sh, setup-hooks.sh, relay.ts, install-local.sh,
                  install-local.ps1, build-and-push.sh, statusline.sh,
                  check-installers.ts, smoke-parsers.ts, ai-live-test.ts
snippets/         CLAUDE.md/AGENTS.md snippets for semantic status reporting
telemetry-worker/ Cloudflare Worker for anonymous telemetry collection
```

## Architecture

### Event Flow
```
Agent (Claude Code / Codex)
  → HTTP hook (async, never blocks agent)
  → localhost relay (if remote setup)
  → POST /api/v1/hooks
  → Event Processor (detect agent type, upsert session, store event)
  → DB + WebSocket broadcast
  → Dashboard UI (real-time updates)
```

### Auth (two modes)
- `DISABLE_AUTH=true` — No auth, all endpoints open (default for local use)
- Auth enabled — API key for hooks, Authentik SSO for dashboard (k8s deployment)
  - `AGENTPULSE_AUTHENTIK_TRUST_SECRET` required for SSO production deployments; see `deploy/k8s/AUTHENTIK-FORWARDAUTH.md`

### AI gate rejection codes

- **404 / `{ error: "ai_disabled" }`** — AI not compiled in or disabled in settings
- **409 / `{ error: "ai_paused" }`** — Kill switch active; watchers paused

Do NOT use `503 / ai_kill_switch_active` — that code was never shipped.

## Key Conventions

- Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- Hook ingestion always returns 200 (rate-limited drops are silent; counter in /health)
- SQLite datetime: `"YYYY-MM-DD HH:MM:SS"` (no T/Z) — use `parseDate()` from `src/web/lib/parseDate.ts`
- Session names: adjective-noun pairs from `name-generator.ts`
- DB migrations: append-only ALTER TABLE array in `initializeDatabase()`
- `isWorking` toggles on UserPromptSubmit/PreToolUse (true) and Stop (false)
- Timeline events are filtered **client-side** in session detail UI (not server-side)

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
- `PUT /api/v1/sessions/:id/pin` — Toggle pin
- `PUT /api/v1/sessions/:id/archive` — Archive
- `DELETE /api/v1/sessions/:id` — Delete session + events
- `GET /api/v1/sessions/:id/claude-md` — Get CLAUDE.md content
- `PUT /api/v1/sessions/:id/claude-md` — Save CLAUDE.md content

**Settings:**
- `GET /api/v1/settings` — Get all settings
- `PUT /api/v1/settings` — Update setting (403 for protected keys: `{ error: "key_not_user_settable", key }`)

**Other:**
- `GET /api/v1/search?kinds=session&q=` — FTS5 full-text search
- `GET/POST/DELETE /api/v1/api-keys` — Manage API keys
- `WS /api/v1/ws` — Real-time event stream

## OSS Hygiene

- Never commit real domains, IPs, API keys, hostnames, or private infrastructure identifiers
- Replace private values with safe placeholders before commit
- `deploy/k8s-homelab/` (gitignored overlay) is the correct place for real deployment values
