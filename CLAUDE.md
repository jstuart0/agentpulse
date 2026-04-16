# CLAUDE.md - AgentPulse

## Project Overview

AgentPulse is a real-time web dashboard for monitoring AI coding agent sessions (Claude Code and Codex CLI). It receives hook events from active sessions and displays them in a live dashboard with chat-style prompt history, session notes, and remote monitoring.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS
- **State:** Zustand
- **Database:** SQLite (default) or PostgreSQL (configurable via DATABASE_URL)
- **ORM:** Drizzle
- **Real-time:** WebSocket (native Bun) + 3s polling fallback
- **Telemetry:** Cloudflare Worker + D1 at your-telemetry-host (Cloudflare Worker + D1)
- **Linting:** Biome

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Start dev server (API + Vite)
bun run dev:server   # Start API server only
bun run dev:web      # Start Vite frontend only
bun run build        # Production build
bun run start        # Start production server
bun run check        # Run Biome linter
bun run typecheck    # TypeScript type checking
```

## Project Structure

- `src/server/` - Hono API server
  - `routes/` - API endpoints (ingest, sessions, settings, agents-md, setup)
  - `services/` - Event processor, session tracker, name generator, telemetry
  - `db/` - Drizzle schema, client, migrations
  - `auth/` - API key generation/verification, Authentik middleware
  - `ws/` - WebSocket handler with pub/sub
- `src/web/` - React frontend
  - `pages/` - DashboardPage, SessionDetailPage, SetupPage, SettingsPage, AgentsMdPage
  - `components/` - SessionCard, SessionGrid, StatusBadge, AgentTypeBadge, PlanTracker, Layout
  - `stores/` - Zustand stores (sessions, events)
  - `hooks/` - useWebSocket, useSessions
- `src/shared/` - Shared types and constants
- `deploy/k8s/` - Kubernetes manifests (namespace, deployment, service, ingressroute, middleware)
- `scripts/` - setup-hooks.sh, setup-relay.sh, relay.ts, statusline.sh
- `snippets/` - CLAUDE.md/AGENTS.md snippets for semantic status reporting

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
- `sessions` - id, session_id, display_name, agent_type, status, cwd, model, is_working, is_pinned, git_branch, notes, semantic_status, current_task, plan_summary, total_tool_uses, metadata, timestamps
- `events` - id, session_id, event_type, tool_name, tool_input, tool_response, raw_payload, created_at
- `api_keys` - id, name, key_hash, key_prefix, is_active, timestamps
- `settings` - key, value, updated_at

### Auth (two modes)
- `DISABLE_AUTH=true` - No auth, all endpoints open (default for local use)
- Auth enabled - API key for hooks, Authentik SSO for dashboard (k8s deployment)

### Relay (for remote server users)
Claude Code blocks hooks to non-localhost IPs. The relay (`scripts/relay.ts`) runs on localhost and forwards events to the remote server. LaunchAgent auto-starts it on macOS login.

## API Endpoints

**Public (no auth):**
- `GET /api/v1/health` - Health check
- `GET /setup.sh` - Self-contained hook setup script
- `GET /setup-relay.sh` - Self-contained relay + hook setup script

**Hook ingestion (API key when auth enabled):**
- `POST /api/v1/hooks` - Receive hook events from Claude Code / Codex
- `POST /api/v1/hooks/status` - Receive semantic status updates

**Dashboard API:**
- `GET /api/v1/sessions` - List sessions (filterable by status, agent_type)
- `GET /api/v1/sessions/stats` - Dashboard KPI stats
- `GET /api/v1/sessions/search?q=` - Search sessions
- `GET /api/v1/sessions/:id` - Session detail with prompt timeline
- `PUT /api/v1/sessions/:id/notes` - Save session notes
- `PUT /api/v1/sessions/:id/rename` - Rename session
- `PUT /api/v1/sessions/:id/pin` - Toggle pin
- `PUT /api/v1/sessions/:id/archive` - Archive session
- `DELETE /api/v1/sessions/:id` - Delete session + events
- `GET /api/v1/settings` - Get app settings
- `PUT /api/v1/settings` - Update a setting
- `GET/POST/DELETE /api/v1/api-keys` - Manage API keys
- `GET/PUT /api/v1/agents-md` - Read/write CLAUDE.md files
- `WS /api/v1/ws` - Real-time event stream

## Key Conventions

- Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- Hook ingestion must be fast (< 50ms response, always return 200)
- SQLite datetime format: "YYYY-MM-DD HH:MM:SS" (no T/Z) -- use parseDate() in frontend
- Session names generated from adjective-noun pairs (name-generator.ts)
- DB migrations via ALTER TABLE in initializeDatabase() (append-only array)
- isWorking toggles on UserPromptSubmit/PreToolUse (true) and Stop (false)
- Timeline shows only UserPromptSubmit events (server-side filter)

## Deployment

- **Local:** `docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true`
- **K8s (thor):** `kubectl apply -f deploy/k8s/` (uses Authentik SSO + Traefik IngressRoute)
- **Relay:** `curl -sSL https://server/setup-relay.sh | bash -s -- --key ap_xxx`
- **Docker image:** `ghcr.io/YOUR_ORG/agentpulse:latest` (linux/amd64)
- **Telemetry:** Anonymous pings to project maintainers (opt-out with AGENTPULSE_TELEMETRY=off)
