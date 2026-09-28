# Phase 0 spike — Copilot CLI 1.0.82 / Codex CLI 0.145.0 hook payloads

Campaign: `2026-09-28-deliver-agent-cli-parity`, Phase 0 (D16). All captures were run in
temp directories (`mktemp`-rooted paths under this session's scratchpad), never under
`~/.copilot` or `~/.codex` except where explicitly noted and remediated below.

**Environment**: macOS 26.3 (BuildVersion 25D125), Darwin 25.3.0, date 2026-09-28.

- GitHub Copilot CLI **1.0.82** (`/opt/homebrew/bin/copilot`, Homebrew Cask)
- Codex CLI **0.145.0** (`/opt/homebrew/bin/codex` → `@openai/codex` npm global)
- curl **8.7.1** (x86_64-apple-darwin build of curl on this arm64 Mac — a Rosetta/universal
  binary artifact of the system `/usr/bin/curl`; unrelated to Phase 0 scope, noted because it
  surfaced while checking tool versions. `curl --version` reports `curl 8.7.1`, well above the
  D13 `>= 7.55` guard floor.)

## Commands run

```sh
copilot --help
codex exec --help
copilot help hooks        # "Unknown help topic: hooks"
copilot help config       # documents `hooks` / `disableAllHooks` config keys, no payload schema

# Copilot capture attempt (temp git repo, .github/hooks/agentpulse-capture.json,
# one hook entry per D7-registered event + preToolUse capture-only):
git init -q; git config user.email a@b.c; git config user.name test
COPILOT_CAPTURE_DIR=<tmp>/captures copilot -p "run \`echo hi\` and stop" --allow-all-tools --log-level all
COPILOT_CAPTURE_DIR=<tmp>/captures copilot -p "say hi, no tools needed"
copilot -p "say hi" --model gpt-5-mini

# Codex capture (temp dir, generated D12-shape hooks.json posting to a local Bun capture
# server on 127.0.0.1:8934):
codex exec --dangerously-bypass-hook-trust -C <tmp> --skip-git-repo-check "run \`ls\` and stop"
CODEX_HOME=<tmp>/.codex-home codex exec --dangerously-bypass-hook-trust -C <tmp> --skip-git-repo-check "run \`ls\` and stop"
CODEX_HOME=<tmp>/.codex-home codex exec --enable hooks --dangerously-bypass-hook-trust -C <tmp> --skip-git-repo-check "run \`ls\` and stop"
CODEX_HOME=<tmp>/.codex-home codex exec --dangerously-bypass-hook-trust -C <tmp> --skip-git-repo-check "run \`echo hi\` and stop"   # control: hooks.json placed in CODEX_HOME
codex exec --disable hooks --skip-git-repo-check -C <tmp> "run \`echo fact6probe\` and stop" < /dev/null   # fact 6 probe, real CODEX_HOME
```

Model spend: 7 Copilot invocations (all failed pre-model with a 403 policy denial — see below,
no billed model call actually completed) + 6 Codex `exec` invocations with trivial one-line
shell prompts (`ls`, `echo hi`, `echo fact6probe`, one interrupted `sleep 8`). All within D6's
"trivial prompts only, a handful of model calls" budget.

## Scrub rules applied (D16, F42)

- Codex `cwd` / `transcript_path` captured under this session's scratchpad (a
  `mktemp`-rooted temp path that embeds `$USER` as part of macOS's per-user `/private/tmp`
  layout) were rewritten: the embedded `$USER` → `user`, and the whole project-relative
  prefix → `/home/user/project` (cwd) / `/home/user/.codex/sessions/...` (transcript_path).
  Session ids and turn ids are real captured UUIDs, kept per D16 ("keep session ids unless
  they embed the above").
- No hostname, IPv4/IPv6, or email literal appeared in any raw capture (verified below).
- **Proof the scrub check bites**: ran the plan's exact Phase 0 scrub grep (see the Verification
  section of the plan for the pattern) first against a synthetic unscrubbed JSON sample
  containing a literal macOS home-directory path, a literal short hostname, and a literal
  private IPv4 literal — it matched and reported the line (confirmed the check discriminates).
  Then ran the same grep against `src/server/services/agents/__fixtures__` (this directory) —
  zero matches. The broader campaign OSS-hygiene grep was also run against this directory
  directly — zero matches — and will be re-run against the staged `git diff origin/main` at
  commit time.
- **Post-review fold-in (xander, mid-build)**: the scrub check as originally written matches
  `$USER` only when adjacent to `@` (email context) or inside the macOS home-directory path
  prefix — it does not catch the bare local username elsewhere, e.g. quoted in this document's
  own prose while *describing* the scrub rule. Caught and fixed: this file previously quoted
  the real macOS username literally at what are now lines 47-50 above. The scrub grep run
  against this directory is now additionally checked with a word-boundary match on `$USER`
  alone (catching prose occurrences a path/email-scoped pattern misses) — zero matches,
  directory-wide, fixtures and prose both.

## Facts

1. **Copilot 1.0.82 payload casing and event-name field — WAIVED, docs-derived (`_source:"docs"`).**
   Every live invocation (7 attempts, including a bare `-p "say hi"` with no tools and no
   hooks file at all) failed identically before reaching a model response:
   ```
   Error: Access denied by policy settings (Request ID: ...)
   Your Copilot CLI policy setting may be preventing access. ...
   ```
   `~/.copilot/logs/process-*.log` shows the underlying cause: `[ERROR] Error loading models:
   Error: 403 "unauthorized: not authorized to use this Copilot feature"`. This is a GitHub-side
   organization policy denial on the account's Copilot CLI access, unrelated to hooks, to the
   `--allow-all-tools` flag, or to model choice (`gpt-5-mini` was tried too). It is not a
   trust/permission step I can satisfy non-interactively per D6 — it's a hard access denial at
   the model layer. No hook ever ran (no `hook`-related lines appear in any log), so the D7
   registered-event casing and payload shape could not be observed live. All 10 Copilot fixtures
   are docs-derived (`_source:"docs"`), carrying only D7's already-researched event names and
   the always-plausible base fields (`sessionId`, `cwd`, plus event-specific fields inferred
   from the event's purpose). **Waiver**: every event in
   `src/server/services/agents/__fixtures__/copilot/` — casing, field names, and `toolArgs`
   shape are unverified against the real CLI and must be re-confirmed against a live capture
   (Manual verification item 3, or a later spike) before being treated as ground truth.

2. **Whether `toolArgs` is a JSON string or an object — WAIVED, docs-derived**, for the same
   reason as fact 1. The `postToolUse.json` and `postToolUseFailure.json` fixtures model
   `toolArgs` as a JSON *object* (`{"command": "echo hi"}`), matching Codex's real captured
   `tool_input` shape, but this is an assumption carried over from Codex, not observed on
   Copilot. Flagged as unverified in the same waiver as fact 1.

3. **Codex stdin for `Stop`/`SessionEnd` (and `Interrupt` if triggered) — CONFIRMED (live).**
   Real captures (`Stop.json`, `SessionEnd.json`, `_source:"live"`):
   - `Stop`: `{session_id, turn_id, transcript_path, cwd, model, permission_mode,
     stop_hook_active, last_assistant_message}`.
   - `SessionEnd`: `{session_id, transcript_path, cwd, reason}` — no `model`/`turn_id`. Observed
     `"reason":"other"` on a normal `codex exec` completion (twice, across two separate runs).
   - `Interrupt`: **not triggered.** Sent `SIGINT` to a `codex exec` process mid-tool-call
     (`sleep 8`, interrupted after 3s). Codex printed `turn interrupted` to stdout and exited,
     but the process teardown happened before any `Interrupt` hook command could complete (no
     capture arrived, and `UserPromptSubmit`'s own capture for that run was also lost mid-flight
     even though `hook: UserPromptSubmit` was logged to stdout). `Interrupt.json` is
     docs-derived (`_source:"docs"`), built from the always-present base fields plus `turn_id`
     (the doc states `Interrupt` is turn-scoped like `Stop`). Waivered: not triggerable via
     `codex exec` in this environment.

4. **(F38) D12-shape `buildCodexHooksFile()` output loads on 0.145; matcher-less events fire — CONFIRMED, with a critical caveat (new finding, not in the original fact list).**
   Wrote the exact D12 shape (all 12 events, no `matcher`, `type:"command"`, `async:true`,
   `timeout:5` except `SessionEnd`/`Interrupt` at `timeout:3`) to an isolated `CODEX_HOME`'s
   `hooks.json` (project-level placement doesn't apply — see fact 5) and ran
   `codex exec --dangerously-bypass-hook-trust -C <tmp> "run \`ls\` and stop"`:
   - **No** `failed to parse hooks config` warning appeared — the D12 file shape parses
     correctly on 0.145. That half of fact 4 holds.
   - **But `async:true` hooks are silently skipped on 0.145.** Every hook fired ten
     `warning: skipping async hook in <path>: async hooks are not supported yet` lines (one per
     configured async event), and **only `SessionEnd`** ran, via a distinct
     `warning: running async SessionEnd hook synchronously in <path>` — i.e. Codex 0.145
     force-executes `SessionEnd` synchronously regardless of its `async` flag, and drops every
     other async-marked hook entirely, with no delivery and no retry.
   - **Control test**: regenerated the identical file with `async:false` on every event
     (otherwise unchanged: no `matcher`, same commands) and re-ran with a trivial
     `"run \`echo hi\` and stop"` prompt. This time `SessionStart`, `UserPromptSubmit`,
     `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd` all fired and posted real, matcher-less
     payloads to the capture server (captures `003`–`008`, see below) — confirming "omitted
     matcher = match all" independently of the async bug, and separately printed
     `warning: clamping SessionEnd hook timeout to 3s` (a `timeout:5` on `SessionEnd` gets
     silently clamped down, not rejected).
   - **Consequence for Phase 5 / D12**: as specified (`async:true` for 10 of 12 events), the
     generated hooks file would deliver **only `SessionEnd`** on Codex 0.145 — every other event
     (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, etc.) silently
     never posts. This is a real-CLI-measured blocker on D12's current `async:true` default and
     needs a decision before Phase 5 lands (e.g. `async:false` for all or most events, accepting
     the hook can block the turn up to its `timeout`). Flagged here as a fact, not fixed —
     Phase 5 is out of this phase's scope.

5. **Project-level `.codex/hooks.json` via `-C <tmp>` — CONFIRMED NOT LOADED.**
   Three separate tests, all with an isolated `CODEX_HOME` (no global `hooks.json` present, so
   there's no fallback to confuse the result) and a real `.codex/hooks.json` written at
   `<tmp>/.codex/hooks.json` in the `-C`-targeted project directory:
   - Default feature flags: no hook fired, no parse warning, no `hook:` lines.
   - `--enable hooks` explicit: identical — no hook fired.
   - Control: copying the *same* file into the isolated `CODEX_HOME` root (i.e.
     `$CODEX_HOME/hooks.json`, the global location) made it load and fire immediately (fact 4's
     evidence). So the mechanism itself works; it is specifically the project-scoped
     `.codex/hooks.json` path that Codex 0.145 never reads via `-C`. **No project trust step was
     ever reached, because the file was never even attempted.** Installers must write to
     `$CODEX_HOME/hooks.json` (typically `~/.codex/hooks.json`), matching D12's stated
     replacement target — there is no working project-scoped alternative on 0.145.

6. **(r3, F59) Does `codex exec` append to `~/.codex/session_index.jsonl`? — CONFIRMED: NO.**
   Read-only-on-the-index probe against the **real** `~/.codex` (hooks disabled for this run to
   isolate the measurement; stdin redirected from `/dev/null` to avoid the CLI blocking on a
   held-open pipe):
   ```
   before=474   (wc -l ~/.codex/session_index.jsonl)
   codex exec --disable hooks --skip-git-repo-check -C <tmp> "run \`echo fact6probe\` and stop" < /dev/null
   after=474
   ```
   Zero-byte change. `codex exec` does **not** touch `session_index.jsonl`, consistent with the
   plan's cited openai/codex#15943. This run did write one rollout transcript file under the
   real `~/.codex/sessions/2026/09/28/` (Codex's normal exec bookkeeping, unavoidable when using
   the real `CODEX_HOME` needed to test the *real* shared index) — that file was deleted
   immediately after the measurement (see "Remediation" below); `session_index.jsonl` and
   `history.jsonl` were never modified. **D22's scope is confirmed: interactive (TUI) Codex use
   only** — `codex exec` activity can never satisfy D22's "hooks installed but never fired"
   signal via the index; `basis:"tui_activity"` is the correct label.

7. **(r3, F59) Does a new interactive thread get an index row without being named? — read-only inspection of existing history; not exercised live (TUI, non-interactive per D6).**
   Read-only scan of the real `~/.codex/session_index.jsonl` (474 lines, not modified by this
   spike): **474/474 entries have a non-empty `thread_name`** (keys present on every row: `id`,
   `thread_name`, `updated_at`); zero entries with a missing/empty name were found. This is
   inconclusive on its own — it's consistent with either "unnamed threads never get a row" or
   "every existing thread was eventually auto- or manually named" — and per the plan this
   becomes **Manual verification item 2's check**: open an interactive Codex thread, don't name
   it, and check whether a row appears in the index before naming it.

## Fixture inventory

`src/server/services/agents/__fixtures__/codex/` — 12 files (one per the doc's 12-event
`CodexEvent` set: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`,
`Interrupt`). Each carries `"_source": "live"` or `"_source": "docs"`.

| Event | `_source` | Waiver (if docs) |
|---|---|---|
| SessionStart | live | — |
| UserPromptSubmit | live | — |
| PreToolUse | live | — |
| PostToolUse | live | — |
| Stop | live | — |
| SessionEnd | live | — |
| SubagentStart | docs | Codex CLI has no discoverable subagent-delegation flag/prompt convention (unlike Copilot's `/fleet`); not triggerable via `codex exec` in this environment. Built from base fields + a plausible `subagent_id`/`subagent_name`. |
| SubagentStop | docs | Same as SubagentStart. |
| PermissionRequest | docs | `codex exec` always runs with `approval: never` (no interactive approval path exists in `exec` mode); not triggerable non-interactively. Built from base fields + `PreToolUse`-shaped `tool_name`/`tool_input`/`tool_use_id`, per the doc's description of the event. |
| PreCompact | docs | Requires approaching the context-window limit; not triggerable with a trivial prompt under D6's budget. Built from base fields + a `trigger` field. |
| PostCompact | docs | Same as PreCompact. |
| Interrupt | docs | See fact 3 — triggered via `SIGINT` but the hook never completed before process teardown; no payload captured. Built from base fields + `turn_id`. |

`src/server/services/agents/__fixtures__/copilot/` — 10 files (one per D7's registered
`CopilotEvent` set: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `postToolUse`,
`postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `preCompact`,
`errorOccurred`). **All 10 carry `"_source": "docs"`** — see fact 1's waiver. None were
captured live; the org-policy 403 blocked every invocation before any hook could fire.

## Remediation / disclosed side effects on the real `~/.codex` and `~/.copilot`

Two `codex exec` invocations were run with the default (real) `CODEX_HOME` rather than the
isolated one, because they specifically needed to observe behavior tied to the real shared
state (fact 4's initial parse-warning check against the pre-existing real `~/.codex/hooks.json`,
and fact 6's real `session_index.jsonl` line-count probe). Each wrote exactly one rollout
transcript file under `~/.codex/sessions/2026/09/28/` (Codex's normal `exec` bookkeeping — there
is no flag to suppress it short of `--ephemeral`, which was not used because a plain rollout was
easiest to identify and remove by session id). Both files were deleted immediately after the
relevant measurement was taken, identified precisely by the session id Codex printed to its own
stdout banner:
- `rollout-2026-09-28T15-50-09-01a0e991-4cae-75b0-a091-2661cb5fbaef.jsonl` (fact 4's initial
  real-`CODEX_HOME` parse-warning check) — deleted.
- `rollout-2026-09-28T15-58-11-01a0e998-a8eb-7623-ac25-b880e7fbbf51.jsonl` (fact 6's probe) —
  deleted.

Verified after cleanup: `~/.codex/session_index.jsonl` (474 lines, unchanged throughout),
`~/.codex/history.jsonl` (grep for both session ids: zero matches), `~/.codex/config.toml` and
`~/.codex/hooks.json` (mtimes predate this session) were never modified.

One further, unavoidable, disclosed side effect: invoking `copilot -p ...` (7 times, all of
which failed before reaching a model, per fact 1) caused the CLI's own auto-managed
`~/.copilot/config.json` to be rewritten by Copilot itself (the file's header states "This file
is managed automatically"). No entry was added to its `trustedFolders` array for any of this
session's temp directories, and no hook-trust state was written anywhere — the observed content
is consistent with routine CLI bookkeeping triggered merely by launching the binary, not with
anything this spike explicitly requested.

## Manual test setup fact

Checked `.env.example` and `src/server/config.ts` for the local-dev SQLite path env var named
in the plan's Verification "Manual" setup step 1. `.env.example` documents only `DATABASE_URL`
(empty = SQLite at `./data/agentpulse.db`) and does not mention a path-override variable.
`src/server/config.ts:11,152-154` shows the actual override is **`SQLITE_PATH`**
(`sqlitePathOverride: process.env.SQLITE_PATH || ""`), not `AGENTPULSE_DB_PATH` as the plan's
manual step assumed. The manual-test command should read
`SQLITE_PATH=$(mktemp -d)/ap.db bun run dev:server`, not `AGENTPULSE_DB_PATH=...`.
