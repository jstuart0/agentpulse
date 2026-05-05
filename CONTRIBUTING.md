# Contributing to AgentPulse

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/jstuart0/agentpulse.git
cd agentpulse
bun install
bun run dev
```

This starts the API server on port 3000 and the Vite dev server on port 5173 with hot reload.

## Code Style

- We use [Biome](https://biomejs.dev/) for linting and formatting
- Run `bun run check` to lint, `bun run check:fix` to auto-fix
- Tabs for indentation, double quotes, semicolons
- TypeScript strict mode

## Project Structure

- `src/server/` -- Hono API server (Bun runtime)
- `src/web/` -- React 19 frontend (Vite build)
- `src/shared/` -- Types and constants shared between server and frontend
- `deploy/k8s/` -- Kubernetes manifests (reference, not required)
- `scripts/` -- Setup scripts and relay
- `telemetry-worker/` -- Cloudflare Worker for anonymous telemetry

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run `bun run check` and `bun run typecheck`
4. Test locally with `bun run dev`
5. Open a pull request

## Database migrations

AgentPulse supports two backends — SQLite (default) and PostgreSQL — with separate Drizzle schema files and separate generated migration baselines.

**Schema files** live in `src/server/db/schema/{core,ai,ask-projects}/`. Each table has its own file. Dialect differences (boolean columns, JSON columns, unique indexes) are expressed via a column-factory pattern. Per-dialect entry files:
- `src/server/db/schema/sqlite.ts` — SQLite-specific table definitions
- `src/server/db/schema/postgres.ts` — Postgres-specific table definitions

**The rule**: every schema change must generate two migrations in lockstep.

```bash
# After editing a schema file:
bun run db:generate:sqlite    # writes to drizzle/sqlite/
bun run db:generate:postgres  # writes to drizzle/postgres/

# Verify both diffs are clean before committing:
git diff drizzle/
```

The CI `db:generate.sh` script enforces this with a `git diff --exit-code` guard. A PR that adds a migration for one dialect but not the other will fail CI.

**Existing SQLite installs**: the legacy `initializeDatabase()` DDL path is still active for installs with an existing `sessions` table. Fresh SQLite installs and all Postgres installs use `drizzle-kit migrate` instead. Set `AGENTPULSE_LEGACY_INIT=false` in your `.env` to force the Drizzle path on an existing install (useful for testing migrations locally).

**Running Drizzle commands**:
```bash
bun run db:generate:sqlite     # generate SQLite migration from schema changes
bun run db:generate:postgres   # generate Postgres migration from schema changes
bun run db:migrate:sqlite      # apply pending SQLite migrations (dev use)
bun run db:migrate:postgres    # apply pending Postgres migrations (dev use)
bun run db:studio:sqlite       # open Drizzle Studio for SQLite
bun run db:studio:postgres     # open Drizzle Studio for Postgres
```

Note: the drizzle-kit ESM `.js`→`.ts` resolver requires `scripts/drizzle-hook.cjs`. This is a workaround for a drizzle-kit resolution gap. It is only used at generation time; it has no effect at runtime.

## Key Conventions

- Hook ingestion (`POST /api/v1/hooks`) must always return 200 and respond fast (<50ms). Never block the agent.
- The relay handles `agents-md` locally (filesystem access) and forwards everything else to the remote server.
- SQLite datetime format is `YYYY-MM-DD HH:MM:SS` (no T/Z). Use `parseDate()` in the frontend.
- DB migrations: see the "Database migrations" section above. Do NOT add new ALTER TABLE statements to the legacy `initializeDatabase()` array — add schema changes to the Drizzle schema files and generate migrations.
- Session display names are generated from `src/server/services/name-generator.ts`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
