# CLAUDE.md - AgentPulse

## Project Overview

AgentPulse is the command center for AI coding agents across all your machines. It monitors, orchestrates, and manages Claude Code and Codex CLI sessions from a single dashboard with chat-style prompt history, session notes, templates, managed launches, and remote access from any device.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS
- **State:** Zustand
- **Database:** SQLite only today; PostgreSQL support is not implemented.
- **ORM:** Drizzle
- **Real-time:** WebSocket (native Bun) + 3s polling fallback
- **Telemetry:** Cloudflare Worker + D1 at `telemetry-agentpulse.xmojo.net` (default homelab endpoint; configurable via `TELEMETRY_ENDPOINT` env var in `src/server/services/telemetry.ts`)
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

- `src/server/` - Hono API server
  - `routes/` - API endpoints (~26 files):
    - `ai-gates.ts` — AI feature-gate helpers (requireAiBuild, requireAiActive)
    - `ai-inbox.ts` — Operator inbox (HITL, stuck, risky, failed proposals)
    - `ai-intelligence.ts` — Session intelligence classifier endpoints
    - `ai-providers.ts` — LLM provider CRUD
    - `ai-status.ts` — AI status / diagnostics
    - `ai-watcher.ts` — Watcher config and proposal queue
    - `ask.ts` — Ask command surface (NL interface)
    - `auth.ts` — Login, signup, session, local admin bootstrap
    - `channels.ts` — Notification channels (Telegram, webhook)
    - `csp-report.ts` — CSP violation report receiver
    - `health.ts` — Health check (DB-ready gate)
    - `ingest-counters.ts` — Hook rate-limit counters
    - `ingest.ts` — Hook ingestion (always-200 contract)
    - `internal.ts` — Loopback-only control endpoints (drain, shutdown)
    - `labs.ts` — Labs feature-flag CRUD
    - `launches.ts` — Launch request queue + recommendation
    - `projects.ts` — Project CRUD and resolver
    - `search.ts` — Full-text search (FTS5, BM25-ranked)
    - `sessions.ts` — Session list, detail, notes, rename, archive, delete, claude-md
    - `settings.ts` — Settings allowlist-gated CRUD
    - `setup.ts` — Self-contained hook setup script endpoint
    - `supervisors.ts` — Supervisor registry and host routing
    - `templates.ts` — Session template CRUD + distillation
  - `services/` - ~30 service files + subdirectories:
    - `ai/` — AI control plane (~50 files): classifier, watcher runner, HITL, proposals, context, dispatch-filter, redactor, secrets, risk-classes, spend, auto-watcher, inbox, digest, alert-rule evaluator, template distillation, launch recommender, and more
    - `ask/` — Ask NL resolver, per-intent handlers (launch, resume, search, crud, bulk, session-action, digest, qa, channel, alert-rule, add-project), Telegram helpers, disambiguation
    - `channels/` — Notification dispatch, Telegram client + poller, channel registry, credentials
    - `projects/` — Project service, name-match, cache, resolver
    - `search/` — FTS5 backend, SQLite search types
    - `templates/` — Template service, project resolver
    - `util/` — TTL cache
    - `workspace/` — Clone, scaffold, feature guard
    - `control-actions.ts`, `correlation-resolver.ts`, `event-normalizer.ts`, `event-processor.ts`
    - `launch-compatibility.ts`, `launch-dispatch.ts`, `launch-validator.ts`
    - `labs-service.ts`, `local-auth-bootstrap.ts`, `local-auth-service.ts`
    - `managed-session-state.ts`, `name-generator.ts`, `notifier.ts`
    - `session-tracker.ts`, `settings-service.ts`, `supervisor-registry.ts`
    - `telemetry.ts`, `template-preview.ts`, `transcript-sync.ts`
  - `db/` - Drizzle schema, client, migrations (append-only ALTER TABLE array in `initializeDatabase()`)
  - `auth/` - API key generation/verification, Authentik middleware (header trust gate)
  - `ws/` - WebSocket handler with pub/sub
- `src/web/` - React frontend
  - `pages/` - AskPage, DashboardPage, DigestPage, HostsPage, InboxPage, LaunchDetailPage, LoginPage, ProjectsPage, SearchPage, SessionDetailPage, SettingsPage, SetupPage, TemplatesPage
  - `components/` - SessionCard, SessionGrid, StatusBadge, AgentTypeBadge, PlanTracker, Layout, IntelligenceBadge, MarkdownContent, TopBar, WsStatusChip, SessionTabs, StatCard, SkeletonCard, TokenCounter, and subdirectories:
    - `inbox/` — Inbox card components
    - `session-detail/` — Timeline, tool-use, AI tab
    - `settings/` — Settings panels
    - `templates/` — Template editor and list
  - `stores/` - 8 Zustand stores: `connection-store`, `event-store`, `labs-store`, `projects-store`, `session-store`, `tabs-store`, `ui-prefs-store`, `user-store`
  - `hooks/` - useWebSocket, useSessions
  - `lib/` - `api.ts` (single API client), `parseDate.ts` (import from `src/web/lib/parseDate.ts`)
- `src/shared/` - Shared types and constants (including `session-state.ts`)
- `src/supervisor/` - Local supervisor process (launch/control plane for same-machine sessions)
- `deploy/k8s/` - Kubernetes manifests (namespace, secret template, configmap, PVC, deployment, service, middleware, ingressroute, limitrange, resourcequota, networkpolicy, serviceaccount, backup PVC)
- `scripts/` - setup-hooks.sh, setup-relay.sh, relay.ts, statusline.sh, install-local.sh, install-local.ps1, build-and-push.sh, check-installers.ts, smoke-parsers.ts, ai-live-test.ts, and architecture guard scripts
- `snippets/` - CLAUDE.md/AGENTS.md snippets for semantic status reporting
- `telemetry-worker/` - Cloudflare Worker for anonymous telemetry collection
- `thoughts/` - Research, plans, and architecture decisions (gitignored in OSS commits; present in local working tree)

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

### Database Schema
- `sessions` - id, session_id, display_name, agent_type, status, cwd, model, is_working, is_pinned, git_branch, notes, semantic_status, current_task, plan_summary, total_tool_uses, metadata, timestamps, is_archived. Note: `is_archived` is the canonical archive predicate; `status='archived'` is a legacy value retained for backwards-compat (see `src/shared/session-state.ts`).
- `events` - id, session_id, event_type, tool_name, tool_input, tool_response, raw_payload, created_at
- `api_keys` - id, name, key_hash, key_prefix, is_active, timestamps
- `settings` - key, value, updated_at
- AI control plane (always created; runtime gated by `AGENTPULSE_AI_ENABLED`):
  - `llm_providers`, `watcher_configs`, `watcher_proposals`, `ai_daily_spend`
  - `ai_watcher_runs` — durable wake queue with lease-based claiming
  - `ai_hitl_requests` — first-class HITL workflow separate from proposals
  - `notification_channels` — remote delivery targets (Telegram/webhook/email)
  - `session_templates.metadata` — distilled-template provenance JSON

### AI control plane features
- Session intelligence classifier exposes `health` + reasonCode via
  `GET /api/v1/ai/sessions/:id/intelligence` and batch endpoint.
- Operator inbox at `/inbox` aggregates open HITL, stuck/risky sessions,
  and failed proposals as a discriminated-union read model.
- Project digest at `/digest` groups recent sessions by cwd with daily
  cache invalidated on refresh.
- Template distillation: `POST /ai/templates/distill` returns a draft
  template with provenance; user still reviews before saving.
- Launch recommendation: `POST /launches/recommendation` produces an
  advisory RecommendedLaunch; existing validator remains authoritative.
- Risk classes: `GET/PUT /ai/risk-classes` configure what counts as
  risky for `ask_on_risk` policy. Defaults cover destructive commands,
  credential references, and recent test failures.
- Diagnostics: `GET /api/v1/ai/diagnostics` returns queue depth,
  flags, and OTel configuration. Structured `ai_metric` log events
  are emitted on every wake enqueue and run completion; opt-in
  OTel forwarding via `AGENTPULSE_OTEL_ENDPOINT`.

### AI gate rejection codes

AI routes return consistent rejection shapes. When writing code that calls AI endpoints:

- **404 / `{ error: "ai_disabled" }`** — AI feature not compiled in (`AGENTPULSE_AI_ENABLED` is not set), or AI is disabled in runtime settings. Handle the same way: the feature simply isn't available.
- **409 / `{ error: "ai_paused" }`** — AI is compiled in and runtime-enabled, but the kill switch is active. Watchers are paused; other AI features may still be available.

Do NOT use or document `503 / ai_kill_switch_active` — that code and message were never shipped. The actual contract is the two codes above.

### Auth (two modes)
- `DISABLE_AUTH=true` - No auth, all endpoints open (default for local use)
- Auth enabled - API key for hooks, Authentik SSO for dashboard (k8s deployment)
  - **Authentik trust secret**: `AGENTPULSE_AUTHENTIK_TRUST_SECRET` env var (required for SSO production deployments). Authentik emits `X-Authentik-Verify` via a property mapping on the proxy provider; Traefik's `authResponseHeaders` copies it upstream; AgentPulse verifies with `timingSafeEqual` + length guard. See `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` and `deploy/k8s/RUNBOOK-secrets-rotation.md`.

### Relay (for remote server users)
Claude Code blocks hooks to non-localhost IPs. The relay (`scripts/relay.ts`) runs on localhost and forwards events to the remote server. LaunchAgent auto-starts it on macOS login.

## API Endpoints

**Public (no auth):**
- `GET /api/v1/health` - Health check (returns 503 until DB migrations complete)
- `GET /api/v1/ready` - Readiness probe (returns 503 during graceful drain; 200 when ready for traffic)
- `POST /api/v1/csp-report` - Browser CSP violation report receiver (unauthenticated; rate-limited by Traefik)
- `GET /setup.sh` - Self-contained hook setup script
- `GET /setup-relay.sh` - Self-contained relay + hook setup script

**Hook ingestion (API key when auth enabled):**
- `POST /api/v1/hooks` - Receive hook events from Claude Code / Codex (always returns 200; rate-limited drops are silent, counter exposed in /health)
- `POST /api/v1/hooks/status` - Receive semantic status updates

**Internal (loopback-only; blocked externally by Traefik deny rule):**
- `POST /api/v1/internal/drain` - Initiate graceful drain (sets readiness to 503; only reachable from localhost)

**Dashboard API:**
- `GET /api/v1/sessions` - List sessions (filterable by status, agent_type)
- `GET /api/v1/sessions/stats` - Dashboard KPI stats
- `GET /api/v1/search?kinds=session&q=` - Search sessions/events (FTS5-backed)
- `GET /api/v1/sessions/:id` - Session detail with prompt timeline
- `PUT /api/v1/sessions/:id/notes` - Save session notes
- `PUT /api/v1/sessions/:id/rename` - Rename session
- `PUT /api/v1/sessions/:id/pin` - Toggle pin
- `PUT /api/v1/sessions/:id/archive` - Archive session
- `DELETE /api/v1/sessions/:id` - Delete session + events
- `GET /api/v1/sessions/:id/claude-md` - Get CLAUDE.md content stored for session
- `PUT /api/v1/sessions/:id/claude-md` - Save CLAUDE.md content for session
- `GET /api/v1/settings` - Get app settings
- `PUT /api/v1/settings` - Update a setting (returns 403 `{ error: "key_not_user_settable", key }` for protected keys)
- `GET/POST/DELETE /api/v1/api-keys` - Manage API keys
- `WS /api/v1/ws` - Real-time event stream

## Key Conventions

- Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- Hook ingestion must be fast (< 50ms response, always return 200)
- SQLite datetime format: "YYYY-MM-DD HH:MM:SS" (no T/Z) -- use `parseDate()` (import from `src/web/lib/parseDate.ts`) in frontend
- Session names generated from adjective-noun pairs (name-generator.ts)
- DB migrations via ALTER TABLE in initializeDatabase() (append-only array)
- isWorking toggles on UserPromptSubmit/PreToolUse (true) and Stop (false)
- Timeline shows only UserPromptSubmit events — this filter is applied **client-side** in the session detail UI, not server-side. The API returns all events for a session; the timeline component selects the subset to display.

## Deployment

- **Local:** `docker run -d -p 127.0.0.1:3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true` (use `127.0.0.1:` prefix to avoid publishing auth-disabled server on all host interfaces)
- **K8s:** `kubectl apply -k deploy/k8s/` (uses Authentik SSO + Traefik IngressRoute; image pinned by SHA; see `deploy/k8s/README.md`)
- **Relay:** `curl -sSL https://your-server.example.com/setup-relay.sh | bash -s -- --key ap_xxx`
- **Docker image:** `ghcr.io/jstuart0/agentpulse:<sha>` (linux/amd64; tagged by commit SHA — see `scripts/build-and-push.sh`)
- **Telemetry:** Cloudflare Worker + D1 (default homelab endpoint; configurable via `TELEMETRY_ENDPOINT`)

## OSS Hygiene

When preparing changes for commit or push to the public repository:

- sanitize environment-specific values first
- never commit real domains, internal IPs, API keys, hostnames, personal paths, cluster details, or private infrastructure identifiers unless they are intentionally public
- if a local working change requires private values to function, replace them with safe placeholders before commit
- after push, you may restore local/private values in the working tree if needed, but do not leave them committed
- treat deployment manifests, setup scripts, config files, screenshots, and docs as high-risk for accidental private leakage

Public git history is the source of truth. Local convenience must not leak into commits.

## Plane Project
- Workspace: agile-solutions-group
- Project ID: 7ec41b9d-5efa-4f56-bc82-930f76b01345
- Project Name: AgentPulse
- Identifier: AGEN
