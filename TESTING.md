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

## Web UI logic: pure view-state modules

The React components are thin. What they show is decided by plain functions in modules with no React in them, tested with ordinary `bun test` and no DOM:

- `src/web/pages/dashboard-view-state.ts` (grouping, tab and "shown of" state, the default Mine | Everyone scope, held sort order, the owner predicate), with `dashboard-groups.ts` and `dashboard-scope.ts`
- `src/web/pages/hosts-view-state.ts` (host cards, the exclude notice), `team-view-state.ts` (people and key lists, the mode dialog's choices) and `settings-view-state.ts`
- `src/web/lib/ownership-ui.ts` (the one place the instance mode is compared; `ownership-guard.test.ts` fails if another file compares it), `owner-label.ts`, `owner-scope.ts` and `setup-steps.ts` (the Setup page's copy, including the exclude card's per-sender table)

When you change what a screen shows, change the module and its colocated `*.test.ts`. Solo mode has its own test: `ownership-ui.test.ts` asserts that every team-only flag is false there.

### React hooks without a DOM

Hooks and their effects are driven in a plain `bun test` run through `src/web/test-utils/render-hook.ts`: `installDomStubs()`/`removeDomStubs()` give react-dom a stub container (enough to mount a root that renders nothing), `renderHook(hook, props)` returns `current.value` (the hook's latest result), `render(props)` to mount or re-render and `unmount()`, `flush()` lets pending effects and promises settle, `deferred()` holds a request open on purpose, and `TIMER_MARGIN_MS` is the margin to add when waiting on a debounce by its exported constant. Replace `api` methods on the shared client object for the test and restore them afterwards. See `src/web/hooks/paged-lists.test.ts` for the pattern. A hook test proves the behaviour of the hook; it doesn't prove a component reads it, so changes to layout still need a look in a browser.

## Exclude rule: shared fixtures and three evaluators

The exclude rule is evaluated in three places that must agree: the TypeScript evaluator (`src/shared/exclude-rules.ts`, also embedded in the relay), a POSIX `sh` transcription and a PowerShell transcription (`src/shared/hook-command.ts`). One fixture file, `src/shared/__fixtures__/exclude-cases.json`, holds the case matrix, and each evaluator has its own runner over it:

| Evaluator | Runner |
|---|---|
| TypeScript | `src/shared/exclude-rules.test.ts` |
| `sh` | `scripts/exclude-shim-parity.test.ts`: runs the generated snippet for real under `/bin/sh`, and under `dash`, `bash --posix` and `busybox sh` when present. A missing shell shows as a named skip, not a silent gap. |
| PowerShell | `scripts/exclude-shim-parity-ps.test.ts`: needs `pwsh`; rows that depend on a Windows ACL need a real Windows host. **Nothing PowerShell or Windows has been executed in this repository's test runs**, so those tests are skipped here by name; don't read a green run as evidence they pass. |

A row marked `dedicated: true` can't be written as plain data (it needs a symlink, a hardlink, a permission bit or an ACL); a dedicated test elsewhere asserts it, and the row only keeps the by-name check honest. Add a case by adding a row, then run all three runners. `agentpulse exclude check` also cross-checks the TypeScript and shell answers at run time.

Tests that start the relay or the supervisor must not read the real account's home. They use the test-only account-home overrides (`AGENTPULSE_TEST_RELAY_ACCOUNT_HOME`, `AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME`, `AGENTPULSE_TEST_ACCOUNT_HOME`), and `scripts/check-no-exclude-provider-outside-tests.ts` and `scripts/check-no-test-seam-leaks.ts` (both in `check:architecture`) fail production code that reaches them. After editing the evaluator, run `bun run embed:exclude-rules` and `bun run check:relay-exclude-embed`.

## Team mode fixtures

Route tests that need real callers use `src/server/test-utils/team-fixtures.ts`: local users with a session cookie, owned and ownerless API keys, the stored instance mode and the two key lists, all written through the services the app uses. `db-call-counter.ts` counts statements for the tests that pin what a request may cost.

## What's covered

The suite (~1,800 tests across 150 files at time of writing) covers the watcher pipeline, classifier, launch dispatch, name generator, FTS5/ILIKE search backends (SQLite/Postgres), control actions, Ask thread resolution, secrets encryption, prelaunch actions (workspace scaffold + git clone), Telegram channels, the MCP server package, and the routes that wrap them. New behavioral changes ship with a regression test in the same commit.

## Adding a new test

1. Create `your-feature.test.ts` next to `your-feature.ts`.
2. Import `bun:test` (and `./__test_db.js` if the test needs the AI tables).
3. Run `bun test src/path/to/your-feature.test.ts` while developing.
4. Before committing, run `bun test`, `bun run typecheck`, and `bun run check`.
