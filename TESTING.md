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

There is no `vitest.config`, `jest.config`, `bunfig.toml [test]` block, or any other framework config — Bun's default test runner picks up `**/*.test.ts` automatically. If you're auditing this repo and looking for "evidence of a test framework," look for the `*.test.ts` files themselves; their existence is the evidence.

## Conventions

- Use `bun:test` imports: `import { describe, expect, test, beforeEach, beforeAll } from "bun:test"`.
- For tests that touch the AI control plane, import `./ai/__test_db.js` (or relative path) at the top — it sets up `SQLITE_PATH`, `DATA_DIR`, `AGENTPULSE_AI_ENABLED`, and `AGENTPULSE_SECRETS_KEY` to a tmpdir before the schema imports.
- Use `beforeEach` to delete fixture rows; the database is shared across the suite.
- Test names describe the behavior being locked down, not the function name (`"rejects when no default provider is configured"`, not `"test getDefaultProvider null"`).

## What's covered

The suite (~490 tests across 40+ files at time of writing) covers the watcher pipeline, classifier, launch dispatch, name generator, FTS5 search backend, control actions, Ask thread resolution, secrets encryption, prelaunch actions (workspace scaffold + git clone), Telegram channels, and the routes that wrap them. New behavioral changes ship with a regression test in the same commit.

## Adding a new test

1. Create `your-feature.test.ts` next to `your-feature.ts`.
2. Import `bun:test` (and `./__test_db.js` if the test needs the AI tables).
3. Run `bun test src/path/to/your-feature.test.ts` while developing.
4. Before committing, run `bun test`, `bun run typecheck`, and `bun run check`.
