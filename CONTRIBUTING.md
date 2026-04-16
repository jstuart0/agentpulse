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

## Key Conventions

- Hook ingestion (`POST /api/v1/hooks`) must always return 200 and respond fast (<50ms). Never block the agent.
- The relay handles `agents-md` locally (filesystem access) and forwards everything else to the remote server.
- SQLite datetime format is `YYYY-MM-DD HH:MM:SS` (no T/Z). Use `parseDate()` in the frontend.
- DB migrations are append-only ALTER TABLE statements in `src/server/db/client.ts`.
- Session display names are generated from `src/server/services/name-generator.ts`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
