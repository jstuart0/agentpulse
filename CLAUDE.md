# CLAUDE.md - AgentPulse

## Project Overview

AgentPulse is a real-time web dashboard for monitoring AI coding agent sessions (Claude Code and Codex CLI). It receives hook events from active sessions and displays them in a live dashboard.

## Tech Stack

- **Runtime:** Bun
- **Backend:** Hono (HTTP framework)
- **Frontend:** React 19 + Vite + TailwindCSS + shadcn/ui
- **State:** Zustand
- **Database:** SQLite (default) or PostgreSQL (configurable via DATABASE_URL)
- **ORM:** Drizzle
- **Real-time:** WebSocket (native Bun)
- **Linting:** Biome

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Start dev server (API + Vite)
bun run dev:server   # Start API server only
bun run dev:web      # Start Vite frontend only
bun run build        # Production build
bun run start        # Start production server
bun run db:generate  # Generate Drizzle migrations
bun run db:push      # Push schema to database
bun run check        # Run Biome linter
bun run typecheck    # TypeScript type checking
```

## Project Structure

- `src/server/` - Hono API server (routes, services, DB, auth)
- `src/web/` - React frontend (pages, components, stores, hooks)
- `src/shared/` - Shared types and constants
- `thoughts/` - Research, plans, and decisions
- `deploy/` - Docker and Kubernetes manifests
- `scripts/` - Setup and utility scripts
- `snippets/` - CLAUDE.md/AGENTS.md snippets for agent integration

## Architecture

### Event Flow
```
Agent (Claude Code / Codex) --[HTTP hook]--> POST /api/v1/hooks --> Event Processor --> DB + WebSocket broadcast --> Dashboard UI
```

### Database
- Default: SQLite at `./data/agentpulse.db`
- Production: PostgreSQL (set `DATABASE_URL=postgres://...`)
- Schema managed by Drizzle ORM

### Auth
- Dashboard: Authentik SSO via Traefik forwardAuth (when deployed)
- Hook endpoints: API key bearer tokens
- `/api/v1/hooks*` routes use API key auth (no OIDC)

## Key Files

- `src/server/index.ts` - Server entry point
- `src/server/db/schema.ts` - Database schema (Drizzle)
- `src/server/routes/ingest.ts` - Hook event ingestion
- `src/server/services/event-processor.ts` - Event processing logic
- `src/web/pages/DashboardPage.tsx` - Main dashboard view
- `src/web/stores/session-store.ts` - Session state management

## Conventions

- Use Biome for formatting (tabs, double quotes, semicolons)
- Dark theme is default
- All API routes under `/api/v1/`
- WebSocket at `/api/v1/ws`
- Keep hook ingestion fast (< 50ms response time)
