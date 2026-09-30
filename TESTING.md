# Testing

AgentPulse uses **Bun's built-in test runner**. Tests live colocated with source as `*.test.ts`.

## Run

```bash
bun test                                    # everything
bun run test                                # same, via npm script
bun test src/server/services/ai             # one directory
bun test src/server/services/ai/auto-watcher.test.ts  # one file
bun test --watch                            # watch mode
bun run test:watch                          # same, via npm script
```

## Layout

Tests are colocated with the file they exercise:

```
src/server/services/launch-dispatch.ts
src/server/services/launch-dispatch.test.ts
```

We do **not** maintain a top-level `tests/` directory. Colocation keeps the test next to the code it covers, makes refactors easier (move both files together), and matches the convention the AI control plane was built on.

There is no `vitest.config`, `jest.config`, or any other framework config — Bun's default test runner picks up `**/*.test.ts` automatically. There is one `bunfig.toml`, with a single `[test] preload` entry (see below); it exists to close a specific env-ordering bug (and, as of the home-sandbox fix below, a home-directory isolation bug), not to configure the runner itself. If you're auditing this repo and looking for "evidence of a test framework," look for the `*.test.ts` files themselves; their existence is the evidence.

## Conventions

- Use `bun:test` imports: `import { describe, expect, test, beforeEach, beforeAll } from "bun:test"`.
- For tests that touch the AI control plane, import `./ai/__test_db.js` (or relative path) at the top — it sets up `SQLITE_PATH`, `DATA_DIR`, and the temp-path safety guard before the schema imports.
- `bunfig.toml`'s `[test] preload` loads `src/server/db/test-env-defaults.ts` before any test file's own imports, setting `AGENTPULSE_AI_ENABLED`/`AGENTPULSE_SECRETS_KEY` defaults deterministically regardless of Bun's module-graph discovery order (`src/server/config.ts` freezes these into a plain object at first import, and whichever file happens to reach it first otherwise wins). `__test_db.js` still imports the same module for anything that runs it outside `bun test`.
- Use `beforeEach` to delete fixture rows; the database is shared across the suite.
- **Home-directory sandbox.** The same preload (`test-env-defaults.ts`) points `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` at a fresh per-process temp directory before any test file's own imports run, and patches `node:os`'s `homedir()` and `Bun.spawn`'s/`Bun.spawnSync`'s default `env` to match. This exists because of a real incident (2026-09-30): a test run wrote a `supervisor.json`, appended to `.zshrc`, and created `~/.agentpulse/env` in a developer's real home. Two Bun-specific gaps made a naive per-test `process.env.HOME = tmpDir` override insufficient on its own: Bun's `os.homedir()` doesn't track a `process.env.HOME` mutation made after the process starts (Node's does), and `Bun.spawn`/`Bun.spawnSync` default to a snapshot of the process's own OS-level startup environment when `env` is omitted, not a live read of `process.env` — a subprocess spawned with no explicit `env` from inside a test that had overridden `process.env.HOME` still got the developer's real environment. `src/server/db/test-home-sandbox.test.ts` is the regression guard for both. If you write a test that spawns a subprocess and needs a *specific* known temp directory (not just "not the real home"), keep creating your own via `mkdtemp`/`mkdtempSync` and pass it explicitly — the sandbox only stops the unintentional fallback, it isn't a fixture-directory replacement.
- Test names describe the behavior being locked down, not the function name (`"rejects when no default provider is configured"`, not `"test getDefaultProvider null"`).

## What's covered

The suite (~1,800 tests across 150 files at time of writing) covers the watcher pipeline, classifier, launch dispatch, name generator, FTS5/ILIKE search backends (SQLite/Postgres), control actions, Ask thread resolution, secrets encryption, prelaunch actions (workspace scaffold + git clone), Telegram channels, the MCP server package, and the routes that wrap them. New behavioral changes ship with a regression test in the same commit.

## Adding a new test

1. Create `your-feature.test.ts` next to `your-feature.ts`.
2. Import `bun:test` (and `./__test_db.js` if the test needs the AI tables).
3. Run `bun test src/path/to/your-feature.test.ts` while developing.
4. Before committing, run `bun test`, `bun run typecheck`, and `bun run check`.
