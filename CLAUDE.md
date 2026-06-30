# CLAUDE.md - AgentPulse

## Project Overview

AgentPulse is the command center for AI coding agents across all your machines. It monitors, orchestrates, and manages Claude Code and Codex CLI sessions from a single dashboard with chat-style prompt history, session notes, templates, managed launches, and remote access from any device.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS
- **State:** Zustand
- **Database:** SQLite (default, OSS quickstart) and PostgreSQL (production / multi-replica) — set `DATABASE_URL=postgres://...` to opt into Postgres. SQLite remains default when `DATABASE_URL` is unset or empty.
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
    - `supervisors.ts` — Supervisor registry and host routing; exports `supervisorsAgentRouter` (edge-public agent endpoints at `/api/v1/supervisors/*`) and `supervisorsAdminRouter` (management endpoints at `/api/v1/admin/supervisors/*`, forwardauth-gated)
    - `templates.ts` — Session template CRUD + distillation
  - `services/` - ~30 service files + subdirectories:
    - `ai/` — AI control plane (~50 files): classifier, watcher runner, HITL, proposals, context, dispatch-filter, redactor, secrets, risk-classes, spend, auto-watcher, inbox, digest, alert-rule evaluator, template distillation, launch recommender, and more
    - `ask/` — Ask NL resolver, per-intent handlers (launch, resume, search, crud, bulk, session-action, digest, qa, channel, alert-rule, add-project), Telegram helpers, disambiguation
    - `channels/` — Notification dispatch, Telegram client + poller, channel registry, credentials
    - `projects/` — Project service, name-match, cache, resolver
    - `search/` — `SearchBackend` interface; `FTS5SearchBackend` (SQLite BM25) and `PostgresSearchBackend` (ILIKE); registry dispatches on `config.dialect`
    - `templates/` — Template service, project resolver
    - `util/` — TTL cache
    - `workspace/` — Clone, scaffold, feature guard
    - `control-actions.ts`, `correlation-resolver.ts`, `event-normalizer.ts`, `event-processor.ts`
    - `launch-compatibility.ts`, `launch-dispatch.ts`, `launch-validator.ts`
    - `labs-service.ts`, `local-auth-bootstrap.ts`, `local-auth-service.ts`
    - `managed-session-state.ts`, `name-generator.ts`, `notifier.ts`
    - `session-tracker.ts`, `settings-service.ts`, `supervisor-registry.ts`
    - `telemetry.ts`, `template-preview.ts`, `transcript-sync.ts`
  - `db/` - Drizzle client (`client.ts`), dialect-aware boot path, per-dialect migration runner; schema split across `db/schema/{core,ai,ask-projects}/` with per-dialect entry files (`schema/sqlite.ts`, `schema/postgres.ts`) and a runtime barrel (`schema/index.ts`); generated SQL baselines in `drizzle/sqlite/` and `drizzle/postgres/`
  - `auth/` - API key generation/verification, forwardauth bridge (`forwardauth-bridge.ts`), header trust gate + session resolver (`middleware.ts`)
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
- `deploy/overlays/postgres/` - Kustomize overlay for Postgres-backed deployments (removes backup sidecar, sets `DATABASE_URL`, switches to `RollingUpdate`)
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

Schema is split across `src/server/db/schema/{core,ai,ask-projects}/` with per-table files and a column-factory pattern for dual-dialect differences. Per-dialect entry files (`schema/sqlite.ts`, `schema/postgres.ts`) export the canonical table set for each backend. The runtime barrel (`schema/index.ts`) reads `config.dialect` at module load and selects the appropriate per-dialect barrel; all production importers use it (the legacy `db/schema.ts` shim is deleted, guarded by `scripts/check-no-legacy-schema-import.ts`). Exports are currently cast to SQLite-typed variants for backwards type-compat; narrowing to dual-dialect generics is a follow-up.

- `sessions` - id, session_id, display_name, agent_type, status, cwd, model, is_working, is_pinned, git_branch, notes, semantic_status, current_task, plan_summary, total_tool_uses, metadata, timestamps, is_archived. Note: `is_archived` is the canonical archive predicate; `status='archived'` is a legacy value retained for backwards-compat (see `src/shared/session-state.ts`).
- `events` - id, session_id, event_type, tool_name, tool_input, tool_response, raw_payload, created_at
- `api_keys` - id, name, key_hash, key_prefix, is_active, scopes (JSON text, default `'["ingest"]'`), timestamps
- `settings` - key, value, updated_at
- AI control plane (always created; runtime gated by `AGENTPULSE_AI_ENABLED`):
  - `llm_providers`, `watcher_configs`, `watcher_proposals`, `ai_daily_spend`
  - `ai_watcher_runs` — durable wake queue with lease-based claiming
  - `ai_hitl_requests` — first-class HITL workflow separate from proposals
  - `notification_channels` — remote delivery targets (Telegram/webhook/email)
  - `session_templates.metadata` — distilled-template provenance JSON

Note: `event_embeddings` (vector search) is SQLite-only in this release. The Postgres pgvector port is deferred to a follow-up campaign.

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
- Auth enabled - API key for hooks, forwardauth SSO for dashboard (k8s deployment)
  - **Forwardauth trust secret**: `FORWARDAUTH_TRUST_SECRET` env var (required for SSO production deployments). AgentPulse works with any forwardauth-capable IdP — Authentik (default), Authelia, oauth2-proxy, Pomerium, Cloudflare Access. Traefik's `agentpulse-inject-verify` middleware injects the shared secret; AgentPulse verifies with `timingSafeEqual` + length guard. Configure header names via `FORWARDAUTH_HEADER_*` env vars (defaults are Authentik values). Legacy alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` accepted for one release. See `deploy/k8s/FORWARDAUTH.md` and `deploy/k8s/RUNBOOK-secrets-rotation.md`.
  - **Session bridge** (`src/server/auth/forwardauth-bridge.ts`, AGEN-5): on the first forwardauth-gated request, mints an `ap_session` cookie (8h default; `AGENTPULSE_SSO_SESSION_DURATION_MS`) so `/auth/me` and WS upgrades resolve the SSO identity through the existing cookie step. `auth_sessions` has four additive columns: `auth_source` (text, not-null, default `"local"`), `sso_subject` (nullable), `sso_username` (nullable), `provider` (nullable). SSO sessions are non-admin (`source:"forwardauth"`, `role:null`); no shadow `users` row is created.
  - **`/auth/me` is un-forwardauth'd by design**: listed in the IngressRoute without the middleware chain. Moving it behind forwardauth would break local-auth fallback and double-set the cookie via the bridge. `Bearer ap_*` is authoritative when present — valid key → `api_key` identity; invalid/unknown key → 401 (the cookie is never consulted as fallback).
  - **Supervisor split**: dashboard-management routes at `/api/v1/admin/supervisors/*` (not in the IngressRoute exemption list; falls through to the forwardauth catch-all for live IdP revocation). Machine-agent routes remain at edge-public `/api/v1/supervisors/*` with supervisor-credential auth.
  - **API key scopes (AGEN-9)**: every key carries an explicit capability set stored as a JSON array in `api_keys.scopes` (TEXT NOT NULL DEFAULT `'["ingest"]'`). Two recognized scopes: `ingest` (post hook events) and `manage` (supervisor enroll/rotate/revoke, API-key CRUD). The `*` wildcard is valid in DB records only (never accepted from a client request). `requireScope("manage")` is chained after `requireAuth` on the full `supervisorsAdminRouter` and the three `/api-keys` CRUD handlers. `requireApiKey` (hook path) enforces `ingest`. forwardauth / local sessions are never scope-checked — scoping applies only to `api_key` callers. Rejection: `403 { error: "insufficient_scope", required: "<scope>" }`. Default bootstrap key (`ensureDefaultApiKey`) gets `["ingest","manage"]` so fresh installs aren't locked out. Hook-setup flows (SetupPage, FirstRunWelcome) mint ingest-only keys. **Re-grant procedure**: mint a new key with the desired scopes via Settings (`POST /api/v1/api-keys` with `scopes` param), then revoke the old one — there is no scope-edit endpoint (mint-new + revoke-old is intentional). Fast-follow: `channelsRouter` gating with `manage` is deferred (noted in settings.ts).

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
- `GET /api/v1/api-keys` - List API keys (requires `manage` scope for api_key callers; returns `scopes: string[]` per key)
- `POST /api/v1/api-keys` - Create API key (requires `manage` scope; accepts `{ name, scopes?: string[] }`, defaults to `["ingest"]`; rejects unknown scopes with `400 { error: "invalid_scope", value }`)
- `DELETE /api/v1/api-keys/:id` - Revoke API key (requires `manage` scope)
- `WS /api/v1/ws` - Real-time event stream

## Key Conventions

- Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- Hook ingestion must be fast (< 50ms response, always return 200)
- SQLite datetime format: "YYYY-MM-DD HH:MM:SS" (no T/Z) -- use `parseDate()` (import from `src/web/lib/parseDate.ts`) in frontend
- Session names generated from adjective-noun pairs (name-generator.ts)
- DB migrations: SQLite fresh installs and all Postgres installs use Drizzle migrate (baselines in `drizzle/sqlite/` and `drizzle/postgres/`). Existing SQLite installs use the legacy `initializeDatabase()` path unless `AGENTPULSE_LEGACY_INIT=false`. Schema changes must generate two migrations in lockstep: `bun run db:generate:sqlite` and `bun run db:generate:postgres`.
- isWorking toggles on UserPromptSubmit/PreToolUse (true) and Stop (false)
- Timeline shows only UserPromptSubmit events — this filter is applied **client-side** in the session detail UI, not server-side. The API returns all events for a session; the timeline component selects the subset to display.

## Deployment

- **Local (SQLite default):** `docker run -d -p 127.0.0.1:3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true` (use `127.0.0.1:` prefix to avoid publishing auth-disabled server on all host interfaces)
- **K8s base (SQLite):** `kubectl apply -k deploy/k8s/` (uses Authentik SSO + Traefik IngressRoute; image pinned by SHA; see `deploy/k8s/README.md`)
- **K8s Postgres overlay:** `kubectl apply -k deploy/overlays/postgres/` — see `deploy/overlays/postgres/README.md` for pre-flight steps (context check, DB + user creation, `secret-patch.yaml` fill-in). Rolling deploys are safe: boot serialization uses a session-level `pg_advisory_lock` on the migration client connection.
- **Relay:** `curl -sSL https://your-server.example.com/setup-relay.sh | bash -s -- --key ap_xxx`
- **Docker image:** `ghcr.io/jstuart0/agentpulse:<sha>` (linux/amd64; tagged by commit SHA — see `scripts/build-and-push.sh`)
- **Telemetry:** Cloudflare Worker + D1 (default homelab endpoint; configurable via `TELEMETRY_ENDPOINT`)

**Single-replica constraint**: The deployment is single-replica (`strategy: Recreate`). Watcher in-flight state and other process-local state make multi-instance deployment unsafe until the SQLite to Postgres migration. See `thoughts/2026-04-24-postgres-backend-plan.md`.

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
