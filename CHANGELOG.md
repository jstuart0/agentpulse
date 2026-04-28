# Changelog

All notable changes to AgentPulse are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and — while the
project is still pre-1.0 — breaking changes land under the regular `Changed`
section with a `⚠ breaking` prefix so they're easy to spot.

## [Unreleased]

## [0.2.0-pre.5] — 2026-04-28

The "code-health remediation" cycle. A code-health audit (dexter) flagged
23 findings across persistence layer, type duplication, dead routes,
security/UX papercuts, and perf cache misses. This release works through
all 22 actionable findings (the 23rd, "zero tests," was dismissed as
factually wrong: 486 tests existed; now 561). Plus an auto-watcher
default for Ask-initiated sessions.

### Added

- **AI watcher auto-enables on Ask-initiated sessions.** When Ask
  launches a session, a watcher_configs row is attached at correlation
  time (enabled, ask_on_risk policy, default provider). Five silent
  skip branches keep this from ever failing a launch: not Ask-initiated,
  AI inactive, user opt-out, watcher already configured, no default
  provider. Settings toggle "Auto-enable on Ask-initiated sessions"
  (default true) below the kill-switch row.
- **`bun test` is now discoverable.** New `test` and `test:watch` npm
  scripts, plus a `TESTING.md` at repo root explaining the colocated
  `*.test.ts` convention. Adds the three signals an auditor scans for
  so future code-health audits don't miss the test suite. (META-1.)

### Fixed

#### Persistence layer (DB-1, DELETE-RENAME-1)

- **`ON DELETE CASCADE` on every child of `sessions`.** Seven tables
  (`events`, `managed_sessions`, `control_actions`, `watcher_proposals`,
  `ai_hitl_requests`, `ai_watcher_runs`, `watcher_configs`) had FKs
  declared without cascade, so `DELETE /api/v1/sessions/:id` was
  leaving orphan rows in every one of them. New migration rebuilds each
  table with `ON DELETE CASCADE` via the documented SQLite
  CREATE-INSERT-DROP-RENAME dance. Idempotent: tables already at
  CASCADE skip the rebuild. C-2, H-5.
- **`initializeDatabase()` no longer opens a second SQLite handle.**
  The boot path was racing the module-level production handle.
  Migrations now run on the shared handle by default. C-1.
- **`DELETE /sessions/:id` is now transactional** with a sync callback.
  Cascade does the heavy lifting; the explicit events delete is kept
  as belt-and-braces for older DBs. M-10.
- **`PUT /sessions/:id/rename` extracted to `renameSession()`** in
  session-tracker. Both the `sessions` and `managed_sessions` updates
  are wrapped in a sync `db.transaction(...)` — a partial failure
  rolls back. Note: drizzle bun-sqlite transactions are sync; async
  callbacks silently break rollback. M-2.

#### AI control plane (AI-EVT-1, TYPE-1)

- **`emitAiEvent` requires explicit `source` parameter.** Was hardcoded
  `"observed_hook"` for every AI-emitted event, contaminating the
  authority-based deduplication in `event-processor.ts`. Updated 20
  call sites: `"managed_control"` for watcher emissions, `"observed_hook"`
  for HITL response paths (kept correctly). C-3.
- **`emitAiEvent` now routes through `insertNormalizedEvents`** instead
  of inserting directly. AI events get the same dedup window, authority
  resolution, and FTS5 trigger discipline as observed events. M-4.
- **`ai-events.ts` is now single-responsibility.** `stampWatcherState` /
  `stampUserPrompt` moved to `managed-session-state.ts` (they write to
  `sessions` columns, that's its job). `loadRecentEvents` moved to
  `ai/event-queries.ts`. M-7.
- **`InboxWorkItem` (14-variant discriminated union) lives in
  `src/shared/types.ts`** — no longer duplicated server↔client. **Real
  bug surfaced by unification:** the server has been emitting
  `action_create_freeform_alert_rule` since the freeform alert work,
  but the client switch had no case for it (silently rendered
  undefined). Added the missing case. Promoted `Record<string, unknown>`
  template/launchSpec slots to `SessionTemplateInput` / `LaunchSpec`,
  removed 4 unsafe casts that were papering over the weakened types.
  Drift is now caught at build time via a bidirectional exhaustiveness
  test. H-4.
- **`ActionRequestPayload` is a typed discriminated union.** Replaced
  every `as unknown as <T>` cast in `inbox-service.ts` (13 sites) and
  `action-requests-service.ts` with `narrowPayload<K>(req, k)`. **Real
  bug surfaced:** `add_channel`'s payload had a `kind` field that
  collided with the row-level discriminant — renamed to `channelKind`.
  M-5.

#### Security / settings (SETTINGS-1, H-7)

- **Generic `PUT /settings` rejects protected keys.** Was accepting any
  `{key, value}` from any authenticated user, bypassing the AI
  build-gate. New `upsertSetting()` service throws
  `ProtectedSettingError` on `ai.*`, `vectorSearch.*`, and
  `telegram:credentials`. Generic endpoint returns 403; dedicated
  `/ai/status` and `/ai/vector-search/status` pass `allowProtected:
  true`. H-8, M-6.
- **Startup warning when `DISABLE_AUTH=true` + `HOST=0.0.0.0`.** Local
  dev mode bound to all network interfaces is a fully open mutation
  API; now `console.warn`s prominently at boot. H-7.

#### Performance (CACHE-1, PERF-1)

- **AI feature flags cached** with a 5s TTL.
  `requireAiActive(c)` was issuing 3 settings reads per AI-mutation
  request and once per alert-rule sweep iteration. Cache invalidates
  on writes through `upsertSetting` so operator flips propagate
  immediately. M-8.
- **Telegram credentials cached** with a 60s TTL gate (was indefinite —
  multi-process drift never reflected). H-3.
- **Project cache mutation contract** locked down by a new test —
  `createProject` / `updateProject` / `deleteProject` must call
  `bumpVersionAndReload`. (Audit confirmed all three already do; the
  test prevents future regressions.) H-3.
- **`intelligenceForSessions` now does 4 queries instead of 600.** The
  batch endpoint (cap 200 ids) was looping per-id, doing 3 sequential
  reads each — up to 600 reads under a single SQLite writer lock. Now
  bulk-loaded via `inArray` + a window function for top-N events per
  session. Parity test seeds 50 sessions across mixed scenarios and
  asserts identical results to the per-session path. H-6.

#### Migration hardening (MIGR-HARDENING-1)

- **Migration loop no longer swallows real errors.** Whitelisted three
  idempotent patterns (`/duplicate column name/i`, `/already exists/i`,
  `/index .+ already exists/i`) plus the unchanged lock-retry path.
  Anything else re-throws with the original message and `cause`. A
  truly broken migration no longer silently passes. M-1.
- **`DATABASE_URL=postgres://...` now fails fast at boot** with a clear
  message. The silent fallback to SQLite has been documented as
  "supported" but unimplemented for too long. CLAUDE.md updated:
  "SQLite only today; PostgreSQL support is not implemented." H-2.
- **Startup banner reads version from `package.json`.** Was a hardcoded
  `v0.2.0-pre.2` string literal that drifted with every release. L-1.
- **Deduplicated import in `index.ts`.** L-2.

#### Cleanups (CLEANUP-1, SEARCH-1)

- **Telegram `sendMessage` deduplicated.** Three places constructed
  `fetch("https://api.telegram.org/bot...")` inline. New
  `sendTelegramMessage(botToken, chatId, text, opts?)` in
  `channels/telegram.ts` includes the 4096-char chunk splitter. M-3.
- **Removed `GET /api/v1/sessions/search`.** Hand-written LIKE-based
  route was redundant with the FTS5 `/search` backend, included an N+1
  hydration loop, and had a route-ordering hazard with
  `/sessions/:sessionId`. The FTS endpoint has been the live path for
  a while. H-1, L-3.
- **`parseDate` exported from `web/lib/utils.ts`.** CLAUDE.md said to
  use it; it wasn't exported. M-9.
- **Removed dead `_HIGH_SEVERITY_HEALTH` constant.** L-4.
- **Action-request `kind` validation.** Schema comment refreshed (was
  "launch_request is the only kind in v1"; now lists all 13). Runtime
  gate in `createActionRequest()` throws on unknown kind. L-5.

### Test count

486 → 561 tests across 55 files. Every slice ships with regression
tests; no behavioral change went un-locked-down.

## [0.2.0-pre.4] — 2026-04-27

The "AI-initiated launches with workspace scaffolding + git clone"
cycle. Ask now answers requests like "create a plan for X" or "clone
github.com/foo/bar and start working on it" by walking the user
through project disambiguation, scaffolding a fresh workspace, or
cloning a repo — all gated behind an approval card and capability
checks against connected supervisors. Plus a Codex thread-name
roundtrip and an Authentik fix.

### Added

#### AI task-initiated launches (Slices 1–4)

- **Broader Ask launch-intent gate.** Classifier promoted from a
  narrow "open a session" matcher to a structured intent emitter
  (`{displayName, taskBrief, cloneSpec}`). The verb list now
  includes `create`, `make`, `write`, `draft`, `build`, `fix`,
  `add`, `refactor`, `plan`, `run`, `clone`, `check out`, …, and a
  second-pass `TASK_FLAVOR_PHRASES` gate catches "a plan", "the
  failing tests", `github.com/`, `gitlab.com/`. Defensive parsing
  drops malformed sub-fields rather than failing the whole intent.
- **AI provenance on launched sessions.** Launches initiated from an
  Ask thread persist `aiInitiated: true` and the originating
  `askThreadId` in `launch_requests.metadata`, copied into
  `sessions.metadata` at correlation time
  (`applyLaunchProvenanceToSession`). The session card renders a
  Wand2 glyph in the name chip; `SessionHeader` shows a `← from
  Ask` link back to the originating thread. New
  `LaunchIntent` variants: `none | classifier_failed | launch |
  launch_needs_project | add_project`.
- **Task-derived session names.** When the classifier returns a
  `displayName`, the launch path renames the correlated session at
  ingest using `applyDesiredDisplayName`. Adjective-noun fallback
  (`brave-falcon`) is preserved when no displayName is provided or
  the candidate fails the slug pattern. Slugifier kebab-cases,
  caps at 4 words / 40 chars, with collision suffixing
  (`-2`, `-3`, …).
- **Disambiguation flow when no project is named.** If the user
  asks "create a plan" without naming a project, Ask responds with
  a fenced `ask-message-meta` payload (kind `project_picker`)
  listing the candidate projects plus a path-input fallback and a
  "Scaffold a fresh workspace" CTA (gated on supervisor
  capability). New `ai_pending_project_drafts.kind` discriminator
  ("add_project" | "scaffold" | "clone") and `pendingScaffold` /
  `pendingClone` fields on `LaunchDisambiguationDraftFields`. The
  picker survives across turns until the user picks, types
  `cancel`, or hits the retry cap.

#### AI-driven workspace scaffolding (Slice 5)

- **`scratch` project lifecycle.** New project tag pair —
  `scratch` (this is a one-shot workspace) and `ai-initiated`
  (created by an Ask flow, not a manual "Add project" click). The
  `/projects` page gains a Show-scratch toggle (default off, persisted
  via `ui-prefs-store.showScratch`) so the registry stays clean of
  one-shot workspaces. Scratch cards render with a dashed amber
  border + "scratch" chip. When `scratch` *and* `ai-initiated` are
  both set, the trash icon becomes a `CleanupWorkareaModal` —
  type-`delete` confirmation, runs `rm -rf` on the directory,
  removes the project, and bulk-deletes attached sessions.
  Confirm UI is disabled while submitting and re-enables on error.
- **Workspace settings infrastructure** (`/settings`,
  WorkspacesPanel). Trusted roots (default `~/dev`,
  `~/Documents/dev`, `~/Projects`), trusted-path symlink
  trajectory check (handles macOS `/var` → `/private/var` aliases
  legitimately), default git-init flag, default seed `CLAUDE.md`
  template with token substitution (`{{taskSummary}}`,
  `{{taskSlug}}`; unknown tokens preserved verbatim). Settings now
  nested under `{ workspace: {...}, gitClone: {...} }`.
- **`prelaunchActions` discriminated union on `LaunchSpec`.** New
  optional top-level field (not nested in `providerConfig`)
  carrying actions of kind `scaffold_workarea` or `clone_repo`.
  Capability negotiation: each supervisor advertises a
  `capabilitySchemaVersion` plus boolean feature flags
  (`can_run_prelaunch_actions`, `can_scaffold_workarea`,
  `can_clone_repo`, `can_cleanup_workarea`, etc.). The server
  filters supervisor candidates by required action kind in
  `supervisorSupportsPrelaunch` *before* the
  `validateAgainstSupervisor` loop — the Ask-time CTA gate uses
  the same predicate, so users never see a CTA the host can't
  fulfill.
- **Pure `scaffoldWorkArea` helper.** Idempotent: existing-empty
  directory is OK; existing-non-empty directory rejects with
  `path_not_empty`; SHA-256 verification on seed `CLAUDE.md` (skip
  with warn on SHA mismatch). Symlink-rejection traversal walks
  every component up to the deepest existing ancestor and confirms
  the realpath is on a trusted trajectory.
- **Supervisor handler.** `runPrelaunchActionsForLaunch` invoked at
  the dispatch-launch boundary (both Codex-managed and
  Claude-Code paths). `PrelaunchError` carries a typed
  `PrelaunchErrorCode` (`path_not_absolute`,
  `path_traversal_rejected`, `path_outside_trusted_roots`,
  `symlink_rejected`, `path_not_empty`, `permission_denied`,
  `disk_full`, `git_init_failed`, `claude_md_write_failed`,
  `claude_md_sha_mismatch`, …) so the UI can render actionable
  error copy.
- **Wired `new` keyword in disambiguation.** Picking "Scaffold a
  fresh workspace" walks the user through path confirmation
  (`AskWorkspaceScaffolder` panel: shows resolved path, host,
  defaults; flips to error states for symlink rejection / path
  not empty / permission denied with focus management).
  Confirmation calls back through the Ask composer, the launch
  dispatches with `prelaunchActions: [{ kind:
  "scaffold_workarea", … }]`, and on success the new project is
  registered as scratch + ai-initiated.

#### AI-driven git clone (Slice 6)

- **Clone settings.** Per-tenant defaults under `gitClone.*`:
  `allowSshUrls` (default true), `allowLocalUrls` (default false),
  `defaultDepth` (null = full history), `timeoutSeconds`
  (30–3600). Surfaced in WorkspacesPanel.
- **`clone_repo` PrelaunchAction.** Pure `cloneRepo` helper plus
  URL canonicalization (trailing-slash strip, host lowercase,
  SCP-form preserved) and policy validation
  (`clone_url_invalid`, `clone_scheme_disallowed`,
  `clone_credentials_in_url`). Idempotency rule: an existing
  target directory whose `git config remote.origin.url` matches
  the canonicalized clone URL counts as a hit and skips the
  clone. Stderr classifier maps git failure output to typed
  codes (`auth`, `not-found`, `dns`, `disk-full`, …).
- **Supervisor handler.** `executeCloneRepo` runs `git clone` with
  `GIT_TERMINAL_PROMPT=0` (so credential prompts can't hang the
  supervisor), `AbortSignal.timeout` enforcing the configured
  timeout, optional `--branch` and `--depth`, and cleanup-on-
  partial-failure (only `rm -rf` if the handler created the
  directory).
- **Cloner UI** (`AskWorkspaceCloner`). Sibling component to the
  scaffolder. Renders URL (collapsible `<details>` for long URLs),
  destination, branch, depth, and a "More options" disclosure for
  branch / depth overrides. Error code → human copy + focus
  mapping: `clone_url_invalid` focuses the branch input and
  auto-expands More options; `clone_target_exists` focuses the
  custom-path field; `clone_scheme_disallowed` surfaces a Settings
  link. Slow-clone hint is suppressed when `depth === 1`.
  Telegram-origin renders the branch as read-only.
- **`cloneSpec` routing in `ask-service.ts`.** When the classifier
  returns a `cloneSpec`, the cloneSpec branch fires after the
  pending-draft check but before the regular launch path (sync
  and streaming paths both covered). `pendingClone` and
  `pendingScaffold` are mutually exclusive — handling a clone
  intent clears any prior scaffold draft.

#### Codex thread name roundtrip

- **AgentPulse → Codex.** When AgentPulse renames a session, the
  display name is pushed into Codex's local
  `session_index.jsonl` so `codex resume` and the Codex TUI status
  line show the same name AgentPulse displays.
- **Codex → AgentPulse.** When Codex renames a thread (e.g. via
  `/rename`), the new title is synced back into AgentPulse as the
  session displayName.

### Fixed

- **Authentik forwardauth + API keys.** Hook ingestion requests
  carrying a valid AgentPulse API key now bypass the Authentik
  forwardauth challenge so relays and CLI hooks don't get
  redirected to a login page.



The "projects + Ask command surface" release. Sessions now belong to
first-class projects, templates inherit project defaults with
per-field overrides, and Ask becomes a full command line for the
dashboard — searching, summarizing, launching, editing, and watching,
all through one approval pipeline. No breaking changes.

### Added

#### Projects registry — first-class concept

- New `projects` table with name, cwd, optional GitHub URL, and
  default agentType / model / launchMode. Sessions get a nullable
  `project_id` FK that auto-resolves on event ingest via
  longest-prefix cwd match (path-segment-aware so `/foo/bar`
  doesn't match `/foo/barbaz`). An in-process cache loaded eagerly
  at boot keeps resolution off the DB hot path.
- New `/projects` UI with create / edit / delete drawer, badges
  on `SessionCard` and `SessionDetailPage` header, and a Project
  filter on the dashboard. Endpoints: `GET/POST /api/v1/projects`,
  `GET/PUT/DELETE /api/v1/projects/:id`,
  `GET /api/v1/projects/:id/sessions`.
- One-shot boot backfill stamps `project_id` on pre-existing
  sessions whose cwd matches an existing project — no manual
  re-resolution needed.

#### Template ↔ project linkage with live inheritance

- New `session_templates.project_id` FK + a
  `template_project_overrides` JSON sentinel so individual fields
  can be overridden without making `agentType` / `cwd` columns
  nullable. Project values flow live: change the project's
  `defaultAgentType` and every linked template renders the new
  value on next read. Override semantics: stored value wins where
  the user explicitly overrode, project value fills the rest.
- Templates list endpoint resolves project values via a single
  IN-batch query so resolution stays O(1) extra queries no matter
  the list size.
- Deleting a project nulls `session_templates.project_id` AND
  `sessions.project_id` AND removes the project row in one
  Drizzle transaction. A partial failure rolls all three back.
- Auto-create-project on template save: if a template is saved
  without an explicit `projectId`, the server finds a project at
  the template's cwd or creates a new one (basename-derived name,
  numeric suffix on collision). The dropdown's first option now
  reads "Auto (match by directory)" to communicate the new
  default behavior.

#### AI Ask — read-only patterns (no approval, no mutation)

- **NL session search.** "show me failed sessions",
  "stuck sessions", "find sessions about auth on agentpulse" —
  heuristic keyword gate (no LLM), pure-synchronous filter
  derivation for status / time / project, FTS query with `mode:
  "or"` and a direct-query fallback when the user message is
  all filter words. Each hit is enriched with status + agentType
  via a single batched session lookup.
- **Cross-cutting digest.** "what happened today",
  "give me a digest" — wraps the existing `buildDigest` service
  with a 5s `Promise.race` timeout and a "still loading" footer
  for instances with many live sessions whose intelligence
  classifiers are slow.
- **Per-session Q&A.** "summarize session X", "why did session Y
  fail" — bounded transcript (10k-token tail-truncated, oldest
  events dropped, provenance footer in every reply), spend-cap
  preflight + postflight, response cache keyed on
  `(sessionId, sha256(normalizedQuestion))` invalidated by new
  events. New `ai_qa_cache` table; sweep purges expired rows.

#### AI Ask — mutations through `ai_action_requests` approval

- New `ai_action_requests` table with kinds: `launch_request`,
  `add_project`, `session_stop`, `session_archive`,
  `session_delete`, `edit_project`, `delete_project`,
  `edit_template`, `delete_template`, `add_channel`,
  `create_alert_rule`, `create_freeform_alert_rule`,
  `bulk_session_action`. Atomic claim via conditional UPDATE
  (`awaiting_reply → applying`) prevents double-execution on
  concurrent web + Telegram approvals; `applying → applied /
  failed / expired` lifecycle with `failure_reason`.
- **AI-initiated session launches.** "open a Claude session for
  agentpulse" — keyword gate + LLM classifier resolve project
  and mode, validate against connected supervisors via pure
  helpers (`pickFirstCapableSupervisor`, `buildLaunchSpec`
  extracted from existing impure code), then create an
  approval card. On approve the executor re-validates the
  supervisor and dispatches through the existing `/launches`
  pipeline. Reroute path rebuilds the launch spec when the
  originally-validated host is gone.
- **AI-driven add-project (multi-turn drafting).** "add a
  project myapp at /tmp/myapp" — new
  `ai_pending_project_drafts` table holds in-flight drafts
  keyed on `ask_thread_id`. The AI walks the user through
  numbered questions for missing fields one turn at a time;
  parsing each reply is pure synchronous so continuation
  turns make no LLM call. `cancel`/`abort`/`stop drafting`/
  `never mind` aborts a draft from any question; retry cap
  of 3 per field expires the draft cleanly.
- **Quick session actions.** Pin / note / rename run direct
  with the resolved session name embedded in the reply for
  verification; stop / archive / delete go through approval.
  Notes append now (existing notes preserved with `\n`
  separator); rename replies include an explicit undo hint.
  Stop pre-flight rejects hook-only sessions before creating
  an action_request — `queueStopAction` only works on
  managed sessions.
- **Resume / continue with a new prompt.** "continue
  brave-falcon with: refactor the auth module" — builds a new
  managed launch inheriting the parent session's cwd /
  agentType / model with the user's text as `taskPrompt`.
  Reuses the existing `launch_request` kind; the inbox card
  reads `payload.parentSessionId` and renders "Resume of
  *parentName*" when present so approvers see the resume
  context instead of a generic "New launch" title.
- **Edit / delete project + template via Ask.** Four new
  action_request kinds. Delete cards include affected-template
  and affected-session counts so the approver sees the blast
  radius. Project deletion still uses the transactional
  cleanup so linked templates and sessions are nulled
  atomically.
- **Notification channel setup via Ask.** "set up a Telegram
  channel called personal" — heuristic kind detection
  (`telegram` / `webhook` / `email`); the executor calls
  `createPendingChannel` and sends per-kind enrollment
  instructions back through `notifyOriginUser`.
- **Bulk session operations.** "archive all completed
  sessions on agentpulse" — classifier picks one of two
  resolution strategies (attribute-based SQL or hint-based
  FTS). Pre-flight excludes incompatible targets per action
  (stop excludes hook-only; delete excludes active sessions);
  cap at 50 targets, 20-name preview with "+N more" footer.
  Per-target try/catch keeps a single failure from poisoning
  the rest of the batch; outcome summary message reports
  per-target results.

#### Project-level watcher alert rules

- New `project_alert_rules` table with `REFERENCES projects(id)
  ON DELETE CASCADE`, plus `project_alert_rule_fires` for
  de-bounce. Rule types: `status_failed`, `status_completed`,
  `status_stuck`, `no_activity_minutes`, `freeform_match`.
  `WatcherRunner` gains a 60-second sweep with re-entry guard
  (`alertSweepBusy` flag matching the `RunLeaser` precedent);
  evaluation extracted to `alert-rule-evaluator.ts`.
- **First-run backfill** at rule creation inserts fire rows for
  every session that already matches the rule's predicate, with
  no notification dispatched. Without this, a freshly-created
  `status_stuck` rule on a project with thirty already-stuck
  sessions would notification-storm the user.
- **Freeform watcher rules.** Natural-language conditions like
  "alert when the agent mentions a security concern" run a small
  yes/no LLM classifier per qualifying event. Per-rule daily
  token budget stored on the rule row, atomic daily reset via
  SQL `CASE` so a process restart can't read a stale zero,
  per-rule `last_evaluated_event_id` cursor + 100-event-per-sweep
  cap so a backlog can't blow the budget in one tick. Sample rate
  with cursor advance before sampling so 0.5 still bounds work.
  Spend recorded only on successful classification.

#### Search highlight + event-context

- Search-result event hits now scroll the activity timeline to
  the matching event and apply a 2.2s amber flash. A `useRef`
  guard ensures the flash fires exactly once per
  `(sessionId, eventId)` pair even as new events stream in via
  WebSocket; the ref also marks 404 / network failures as
  terminal so the effect can't loop on deleted events.
- New `GET /api/v1/sessions/:sessionId/events/:eventId/context?around=N`
  endpoint returns the target event ± a window (default 20, max
  100). Used by the frontend to splice older events into the
  timeline state when the search hit references an event outside
  the loaded window.

#### Telemetry classification + diagnostics

- Telemetry pings now include an `install_class` field
  (`production` / `self_hosted_real` / `dev` / `test` / `ci`)
  inferred from build channel, with explicit overrides via
  `AGENTPULSE_TELEMETRY_MODE` and `AGENTPULSE_TELEMETRY_TEST=1`.
  Local and CI runs no longer pollute real-world install counts.
- Added a `first_boot` vs `heartbeat` event_kind so the homepage
  adoption number can show distinct installs vs activity.
- New `GET /api/v1/settings/telemetry/status` returns last-attempt
  diagnostics; `POST /api/v1/settings/telemetry/ping` triggers an
  immediate send. Both gated by `requireAuth`.

### Changed

- `resolveActionRequest` dispatches via a `KIND_EXECUTORS`
  registry object instead of an if-chain. Each new action kind is
  a one-line registry entry; an unsupported kind fails cleanly
  with `Unsupported action kind: <kind>`.
- Inbox card rendering split into per-kind components under
  `src/web/components/inbox/`. The dispatch is a single
  exhaustive `switch` on `item.kind` so TypeScript flags any
  missing case at compile time.
- `decideActionRequest` route now labels failures by action kind
  ("Project edit failed: …", "Bulk session action failed: …",
  "Freeform alert rule failed: …") instead of always saying
  "Launch failed: …". The 422 / 409 split distinguishes terminal
  failure during this approval (expired / failed) from a real
  race-lost (another approval claimed first).
- `evaluateAlertRules` extracted from `event-processor.ts` into a
  dedicated `alert-rule-evaluator.ts` so the four rule-type
  evaluators share one home with the shared
  `dispatchAlertRuleNotification` helper.
- `resolveSession` extracted from `ask-session-action-handler.ts`
  to a shared `ask-resolver.ts` so Slice B's Q&A handler and
  Slice C's bulk handler can use the same FTS-backed
  ambiguity-protocol session picker without depending on the
  session-action handler.
- `sendTelegramActionRequest` extracted from
  `ask-launch-handler.ts` into `telegram-helpers.ts` since four
  handlers now need it.
- `updateTemplate` and `deleteTemplate` extracted from inline
  route logic into a `templates-service.ts` module so the new
  edit / delete executors can call service functions instead of
  duplicating route logic.
- Ask `runAskTurn` chain now processes intent gates in this
  order: open-draft continuation → digest gate → search gate →
  add-project gate → session-action gate → resume gate → CRUD
  gate → channel gate → alert-rule gate → bulk gate → launch
  gate → normal LLM completion. Multi-turn drafting always wins
  over a fresh intent on the same thread.
- `SearchFilters.sessionStatus` now accepts `"failed"`. Closes a
  previously-undocumented gap where `failed` was a valid
  `Session.status` value but couldn't be filtered against in
  the search UI or NL search resolver.
- `sessions` table gains a `is_archived` boolean column,
  orthogonal to `status` so a failed or completed session can be
  archived without losing its terminal status. The new
  `PUT /api/v1/sessions/:id/archive` route flips this flag; the
  CLAUDE.md route reference is now backed by an actual handler.
- `launch_requests` table gains a nullable `parent_session_id`
  column for traceability of resume launches. The launch
  pipeline does not read it; future "session tree" UI will.
- `CreateActionRequestInput.kind` widened to the full eleven
  kinds the plan introduces, in one schema-less union edit, so
  each new slice's executor branch fails compilation cleanly
  until its handler lands.
- `notes` semantics for the AI's add-note path are now append
  (read existing, concat with `\n`, write back) so the AI can't
  silently destroy prior notes. The direct
  `PUT /sessions/:id/notes` route is unchanged (full replace);
  this only differs in the `add_note` Ask path.
- Local OpenAI-compatible providers (Ollama, vLLM, llama.cpp)
  now receive `reasoning_effort: "none"` on classifier calls so
  qwen3 and similar reasoning models return clean JSON instead
  of burying the response in chain-of-thought. The existing
  `think: false` and `chat_template_kwargs.enable_thinking:
  false` flags were silently dropped by Ollama's
  `/v1/chat/completions` endpoint — kept for back-compat but
  `reasoning_effort` is what does the work. Anthropic / OpenAI /
  Google / OpenRouter providers receive the prompt unchanged.

### Fixed

- **Default-projectId stamping race.** `bumpVersion()` originally
  fired the cache reload as `void reloadCache()` — non-blocking.
  `createProject` immediately fed `getCachedProjects()` into
  `resolveAllSessionsForProject`, so a freshly-created project
  could miss its own session-stamp pass and leave matching
  sessions unstamped until the next event-ingest. Now
  `bumpVersionAndReload` awaits the reload before returning.
- **Search-highlight context fetch could loop on deleted events.**
  When the target event id no longer existed (`404` from the
  context endpoint), the effect's `loadingContext` flip retriggered
  the same fetch on the next render — infinite 404s. The catch
  branch now marks `(sessionId, eventId)` as terminal in
  `flashedRef` so the early-return chain short-circuits the
  effect on subsequent re-runs.
- **Misleading "race_lost" message** when a `/decide` call's own
  approval transitioned the action_request to `expired` or
  `failed` during execution. The route conflated genuine race
  losses with terminal-during-this-attempt outcomes. The resolver
  now returns a discriminated `ResolveResult` and the route
  branches on `reason` — race-lost is 409, terminal failure is
  422 with the real reason.
- **`sessions.status = "failed"` was never written.** The value
  existed in the type union and schema comment but had no
  producer in the codebase. Launch dispatch now invokes
  `markSessionFailed` when a launch transitions to failed —
  required before the `status_failed` alert rule could fire on
  anything.
- **Periodic alert-rule sweep had no re-entry guard.** A slow
  sweep (50 sessions × Telegram round-trip) overlapping with
  the next 60s tick could produce two concurrent Telegram
  messages for the same rule/session before the UNIQUE
  constraint stopped the second DB insert. Added an
  `alertSweepBusy` flag matching the `RunLeaser` precedent.
- **`no_activity_minutes` filter missed idle-but-not-stopped
  sessions.** Original spec used `isWorking = true` which
  doesn't catch sessions that emitted `Stop` but haven't
  started a new task. Filter now uses `endedAt IS NULL`.
- **Daily token-budget reset for freeform rules was a
  read-modify-write race.** A process restart mid-day could
  re-read a stale `0` from the previous reset and classify
  events that should have been blocked. Reset is now an atomic
  SQL `CASE` UPDATE per row so concurrent processes can't
  diverge.
- **Spend counter incremented on LLM errors.** Freeform-rule
  classification now records spend only on successful
  classification — `classifyFreeformCondition` returns a
  discriminated `ClassifyResult` and the caller skips spend
  recording on the error path.
- **Telegram approve-callback identifier mismatch fixed in the
  add-project flow.** Action_requests now persist
  `notification_channels.id` (UUID) on the `channelId` column,
  not the raw Telegram chat id; inbound callbacks look up the
  channel by chat id and match on the persisted UUID — same
  pattern HITL already uses.
- **Lint formatter drift on telemetry classification commit**
  fixed before the merge so the project's `bun run check`
  stays at zero errors.


## [0.2.0-pre.2] — 2026-04-25

The "find any past conversation" release. Three new layers stack on
top of session state so Ask actually works across compaction
boundaries and across past completed work — full-text first, then
LLM query expansion, then optional vector embeddings for true
semantic recall. No breaking changes.

### Added

#### Full-text search (`/search`)

- New SQLite FTS5 backend behind a `SearchBackend` interface so a
  Postgres `tsvector` impl can slot in later without changing
  routes or UI. Two virtual tables (sessions + events), porter +
  unicode61 tokenizer, BM25 ranking normalized to 0..1.
- Triggers on `INSERT`/`UPDATE`/`DELETE` of `sessions` and
  `events` keep both indexes in sync. Event indexing filters to
  meaningful types (`UserPromptSubmit`, `AssistantMessage`,
  `Stop`, `TaskCreated`/`TaskCompleted`, `SubagentStop`,
  `SessionEnd`, `AiProposal`, `AiReport`, `AiHitlRequest`).
- Boot-time backfill detects row-count divergence between source
  tables and FTS and re-indexes the gap in a single transaction —
  upgrades from 0.2.0-pre.1 light up retroactively without manual
  rebuild.
- Query escaping: tokens are phrase-quoted before MATCH so inputs
  with `-`, `:`, `(`, etc. don't get parsed as FTS5 operators.
  New `mode: "and" | "or"` filter — AND default for the search
  box, OR for programmatic callers.
- New `/search` page with URL-stateful filter UI (agentType,
  status, eventType, kind), `<mark>`-highlighted snippets, links
  back to the originating session and event.
- New `GET /api/v1/search` and `POST /api/v1/search/rebuild`.

#### Semantic Ask (LLM query expansion)

- Pluggable `SemanticEnricher` interface returning `extraTerms`
  (lexical synonyms) and `directHits` (sessionId → score). Vector
  enrichment populates the latter, leaves the former empty;
  `LlmQueryExpander` does the inverse.
- `LlmQueryExpander` calls the default LLM provider with a tight
  prompt asking for 5–10 comma-separated synonym terms. Output
  parser tolerates chatty preamble, numbered lists, quotes, and
  unclosed `<think>` blocks. Caps at 15 deduped terms.
- New `CompositeEnricher` runs multiple enrichers in parallel and
  unions their results — so vector + LLM expansion compose
  cleanly when both are configured. One enricher failing doesn't
  poison the other.
- Ask resolver now folds the enricher's `extraTerms` and
  `directHits` into its FTS query and pool extension. `keen-worm`
  (or whatever your "I worked on coupling for two days" session
  is) finally surfaces even when the user's question paraphrases
  rather than quotes the original work.
- Ask context builder pulls each session's **top FTS-matching
  events**, not just the most-recent tail, so the LLM sees the
  evidence that earned each session a spot in the candidate list.

#### Vector search — install-time-optional, AI-gated

- New `AGENTPULSE_VECTOR_SEARCH=true` build flag (off by default,
  zero overhead unset). When set, creates an `event_embeddings`
  table (event_id PK, model, dim, vector BLOB), a delete-cascade
  trigger, and the Settings → AI → Vector search subsection.
- `EmbeddingAdapter` interface with an `OllamaEmbeddingAdapter`
  implementation (uses `/api/embed` batched, falls back to legacy
  `/api/embeddings` per-input on older Ollama versions). Strips a
  trailing `/v1` from the LLM provider's baseUrl so the OpenAI-
  compatible chat URL works as the embedding host without
  reconfiguration.
- Default embedding model **`mxbai-embed-large`** (335M params,
  1024-dim, top-5 MTEB English in its weight class, ~30–60ms per
  embed). Switchable in Settings to **`qwen3-embedding:8b`**
  (8B, 4096-dim, top-tier MTEB, ~200–500ms per embed) for
  installs with the headroom.
- Ingest hooks fire-and-forget `embedEvent(id)` from the session
  bus listener — adds zero latency to the hook hot path. Boot-
  time backfill kicks off a background task when row counts
  diverge and reports progress through the Settings UI.
- New `VectorEmbeddingEnricher` brute-force scans event vectors
  for the active model, computes cosine similarity, aggregates
  per-session as `max + log1p(count) × 0.05`. Filters out hits
  below a 0.4 floor (typical noise threshold for unit-normalized
  retrieval models). Sub-100ms over ~10K vectors; sqlite-vss can
  slot in around 100K events.
- Settings UI: enable toggle, model picker (datalist with
  recommended models + hints), live-polling indexing progress
  bar, "Re-index now" button.
- Endpoints: `GET/PUT /api/v1/ai/vector-search/status`,
  `POST /api/v1/ai/vector-search/rebuild`.

#### Other additions

- Resolver tests (#10, merged via #11 from @mvanhorn) — stopword
  filtering, multi-keyword ranking, tie-break ordering,
  archived-session exclusion, explicit-id order preservation.
- Kustomize base + overlay pattern (`deploy/k8s/kustomization.yaml`,
  `deploy/README-kustomize.md`). Environment-specific overlays
  go under gitignored `deploy/k8s-*/` so private values
  (registry, hostnames, TLS secret) never leak into the OSS
  base. Full apply flow: `kubectl apply -k deploy/k8s-<name>/`.

### Changed

- `fetchSessionsById(ids)` returns rows in the caller's input
  order instead of SQLite rowid order. Internal callers don't
  rely on ordering; external importers can now trust the result
  to match the input list.
- Ask resolver no longer excludes completed sessions when FTS
  surfaces them. "Find a session where I worked on X" was always
  going to be about past finished work; the active-only filter
  hid the right answer.
- FTS-surfaced session ranking now uses
  `max(score) + log1p(count) × 0.1` per session, not just max.
  BM25 penalizes high-frequency documents; a session *about* the
  topic (many moderate hits) was losing to one with a single
  rare-term bullseye.
- LLM provider's openai-compatible adapter:
  - Adds `think: false` (Ollama ≥0.7) and
    `chat_template_kwargs.enable_thinking: false` (vLLM/SGLang)
    to suppress reasoning blocks that consumed the entire output
    window without producing the answer.
  - Falls back to `choices[0].message.reasoning` when `content`
    is empty so Qwen3 thinking-mode responses surface useful text
    even when the answer didn't fit in the budget.
- `event_processor.insertNormalizedEvents` returns real DB row
  IDs via `.returning()` instead of `id: 0` placeholders.
  Required for ingest-time vector indexing; consumers who relied
  on the placeholder behavior… don't exist (verified across the
  repo).
- Memory limit bumped 512Mi → 1Gi in the base deployment;
  homelab overlay further bumps to 2Gi to absorb Ask streams +
  enricher LLM fetch buffering on bigger workloads.
- TLS secret name in the base IngressRoute scrubbed from a
  cluster-specific wildcard name to the placeholder
  `agentpulse-tls`. Real cert names go in the gitignored
  overlay.

### Fixed

- **Search returned 500 in 2ms** under any concurrent ingest
  load. The FTS backend was opening a second `bun:sqlite`
  connection that raced the primary connection's WAL snapshot.
  Now shares the drizzle-owned handle with `PRAGMA
  busy_timeout = 5000` so brief writer collisions block + retry
  instead of throwing.
- **Ask SSE stream dropped during enricher warmup.** With LLM
  expansion in front of the main Ask call, time-to-first-token
  on local-Qwen setups climbed to 15–20s. The route now emits
  `: keepalive\n\n` every 5s while the model is warming, so the
  browser / Traefik don't time out the idle connection.
- **Vector backfill stuck at 22 events** with `running: true`.
  Events without extractable text (`Stop`, `SubagentStop`,
  `SessionEnd` with no content) were correctly skipped, but the
  next batch query's LEFT JOIN re-surfaced them indefinitely.
  Now writes a `dim=0` placeholder row so the join excludes them
  from future batches; the cosine query already filters by
  `dim = adapter.dim` so placeholders are invisible to lookups.
- **Pre-existing FTS data wasn't indexed** on upgrades — triggers
  only fire on new writes. The boot-time backfill (above) closes
  this gap automatically.
- **Ollama embed URL hit `/v1/api/embed` (404)** when the LLM
  provider's `baseUrl` ended in `/v1` (the standard OpenAI-
  compatible chat path). Embed adapter now strips a trailing
  `/v1` before building the embed URL.
- **Pod OOMed mid-Ask-stream** under 512Mi limit (exit 137).
  Memory bumped + responsible code paths tightened.
- **AND-mode FTS query of full Ask message** practically never
  matched — every token had to appear in one document. The Ask
  resolver now passes only the stopword-filtered tokens and uses
  OR mode; users still get AND in the search box where
  specificity is the goal.

### Fixed — documentation

- Postgres backend is not yet implemented. README, wiki, and
  release notes previously implied `DATABASE_URL=postgres://…`
  works; it doesn't (parses, then falls back to SQLite with a
  warning). Tracking issue #12. Phased port plan in
  `thoughts/2026-04-24-postgres-backend-plan.md`.

## [0.2.0-pre.1] — 2026-04-23

First pre-release after 0.1.0. Focused on making setup friction-free
and adding a conversational interface on top of the session state.
Breaking changes: none — existing 0.1.0 deployments migrate forward
automatically (new columns added via idempotent ALTER TABLE with a
retry-on-lock path).

### Added

#### Ask assistant (Labs)

- **Global chat at `/ask`** — ask questions about your live sessions
  ("how is the agentpulse one progressing?", "any stuck agents?",
  "give me a status across all active tabs"). Uses the LLM provider
  marked default in Settings → AI.
- **Resolver + context builder** — scores active sessions by fuzzy
  match on displayName / cwd / branch / currentTask / agentType and
  builds a terse `<sessions>` block (metadata + plan + tail of
  meaningful events) for the LLM. Breadth hints (all/every/across/…)
  widen the pool to 20 sessions.
- **Persistent threads** in `ask_threads` / `ask_messages` with
  provenance chips linking replies back to the sessions that
  informed them.
- **SSE streaming** on the web: tokens render live as they arrive.
  Gated to HTTP/1.1-safe response headers (no `Transfer-Encoding`)
  so Traefik + HTTP/2 don't reject the stream.
- **Markdown rendering** for assistant replies via the existing
  `MarkdownContent` component (remark-gfm tables / strikethrough,
  fenced code blocks, links). User messages stay plain pre-wrap.

#### Ask via Telegram

- DM the enrolled bot with any free-form question and get a grounded
  reply back in the same chat. One persistent thread per Telegram
  chat; context carries between messages.
- **Origin-preserving delivery**: a Telegram-origin question answers
  only in Telegram; a web question answers only in the HTTP response.
  Thread rows carry `origin` + `telegramChatId`; the service rejects
  cross-origin replies. AskPage shows Telegram threads with a blue
  badge and disables the composer on them.
- **Per-channel opt-out** (`askEnabled` in channel config) surfaced
  as a checkbox in Settings → Telegram. Default on.
- 4096-char chunking with newline-preferred split boundaries;
  `typing…` indicator while the LLM generates.

#### Telegram setup (first-class in-app)

- **Paste-token wizard** replaces the old env-var-only flow. Bot
  token + webhook secret live encrypted (AES-256-GCM via the
  existing secrets module) in the `settings` table. Env vars still
  work as a bootstrap fallback.
- `POST /channels/telegram/credentials` validates the token via
  `getMe`, auto-generates a webhook secret, optionally auto-
  registers the webhook using `window.location.origin`. Rotation
  and removal are single-button actions.
- **Polling delivery mode** for instances that aren't publicly
  reachable (home-lab, NAT'd, private-DNS MetalLB). Long-polling
  `getUpdates` on a 25-second timeout; auto-resumes on boot. UI
  lets users switch between webhook and polling at any time — the
  service tears down whichever side isn't wanted before standing
  up the new one.

#### AI provider UX

- **"Load available models"** button on the provider form. Probes
  `/models` (OpenAI-compatible) or `/v1/models` (Anthropic) with the
  in-form connection details and turns the Model field into a
  dropdown of the server's actual loaded models. Invalidates on
  connection-detail change so a stale list can't get saved.

#### Setup & onboarding

- **Dashboard empty state** now shows a `FirstRunWelcome` card that
  collapses the three first-run tasks (mint API key, copy install
  command, start an agent) into one screen. Minting works inline —
  no more hunting through Settings.
- Setup page Step 1 lists existing active key prefixes, adds a
  "Create new key" button that threads the raw value through to the
  config blobs, keeps the paste-an-existing-key path.

#### Resilience

- **Auto-reload on expired Authentik session**: api fetches now use
  `redirect: "manual"`; cross-origin 302s surface as `opaqueredirect`
  and trigger a top-level `window.location.reload()`, which DOES
  follow the redirect and completes the OIDC round-trip silently.
  WebSocket counterpart: three consecutive close events with no
  successful open between them triggers the same reload. Successful
  opens reset the counter.
- **DB migrations retry on SQLite lock contention** with exponential
  backoff (250ms → 32s). Previously the migration loop swallowed
  "database is locked" errors as if they were idempotent "column
  exists" failures, leaving new pods running against a stale schema.

### Changed

- New Telegram setups default to **polling mode**. Webhook requires
  a public URL, which most home-lab deployments don't have.
- Watcher **no longer listens to `session_updated` events**. Every
  hook ingest, supervisor heartbeat, and the 60-second stale-session
  sweeper fire that event; the watcher was enqueuing a trigger-less
  `manual` run on each one (~19 runs/minute for an active session
  against 6 real triggers). Dedupe short-circuited them before the
  LLM call but the churn still generated hundreds of DB rows and
  amplified cold-start LLM failures. `session_event` alone covers
  the real triggers (UserPromptSubmit / Stop / TaskCompleted /
  ai_error / plan_update).

### Fixed

- **Telegram webhook 401** when the channel was enrolled and the
  callback reached the server. Hono's path-prefixed `use()`
  middleware applied the auth guard to the public webhook route
  even though the handler was registered first; merging the public
  webhook into the `api` bundle made it inherit auth from unrelated
  sibling routers (`sessions`, `settings`, `ai`, `labs`, etc. all
  do `use("*", requireAuth())`). Fixed by mounting
  `telegramWebhookRouter` directly on the root app outside the
  `api` bundle and switching `channelsRouter` to per-route auth.
- **Ask streaming `ERR_HTTP2_PROTOCOL_ERROR`**: Hono's `streamSSE`
  helper unconditionally sets `Transfer-Encoding: chunked`, which
  is a connection-specific header **forbidden** by HTTP/2 (HTTP/2
  has its own framing). Traefik terminates HTTP/2 with the browser,
  sees the illegal header, browser rejects. Switched to a manual
  `ReadableStream` + `new Response(stream, { headers })` — Bun +
  Traefik now negotiate framing per-connection (HTTP/2 DATA frames
  downstream, chunked upstream). An initial `: stream-open` comment
  nudges strict proxies to flush response headers immediately.
- **Surface upstream errors in the UI**: the default `request()`
  helper swallowed server-side `{ error: string }` bodies on !ok,
  leaving users staring at a generic "API error: 502 Bad Gateway".
  Now reads the JSON body and shows the server's error field (falls
  back to text / status). Added server-side logging on Telegram
  `setWebhook` failures so operators can see Telegram's refusal
  reason ("Bad Request: bad webhook: IP address X is reserved")
  in pod logs.
- Telegram enrollment path on startup no longer hangs when the DB
  is locked during a rolling pod update (retry path above).

## [0.1.0] — 2026-04-23

First tagged state of the public repo. Everything below ships in the image
currently deployed at `agentpulse.xmojo.net`.

### Added

#### Authentication

- **Local accounts** (username + password) as a third auth source alongside
  Authentik forwardauth and API-key bearer. Priority order:
  Authentik header → `ap_session` cookie → API key.
- First-run signup flow: when the users table is empty and
  `AGENTPULSE_ALLOW_SIGNUP` is true (default), the login page auto-switches
  to signup and the first account is created as an admin and auto-logged-in.
- Optional bootstrap admin via `AGENTPULSE_LOCAL_ADMIN_USERNAME` /
  `AGENTPULSE_LOCAL_ADMIN_PASSWORD` — re-synced on every boot.
- `POST /auth/change-password` — local accounts can rotate their own
  password; all other sessions for that user are revoked.
- `GET /auth/me` — public introspection endpoint the UI uses to decide
  between login page, signup page, and app shell.
- Session storage: SHA-256-hashed tokens in `auth_sessions`, 30-day
  lifetime, lazy expiry on read + hourly sweeper.

#### AI control plane (Labs)

All AI features ship gated behind per-feature Labs flags and a master
`AGENTPULSE_AI_ENABLED` runtime switch.

- **Watcher runtime** with durable wake queue (`ai_watcher_runs`), lease-
  based claiming for horizontal scale-out, and crash-safe replay.
- **LLM adapters** for Anthropic and any OpenAI-compatible provider,
  credentials encrypted with AES-256-GCM via `AGENTPULSE_SECRETS_KEY`.
- **Secret redactor** with a default deny-list (AWS keys, JWTs, bearer
  tokens, etc.) plus user-configurable regex rules. Invalid user rules
  are skipped with a warning rather than crashing the pipeline.
- **Decision parser** and outgoing-prompt dispatch filter so watcher
  output can't silently inject commands.
- **Context builder** with cacheable prefix and explicit untrusted-content
  marking to stay inside Anthropic prompt-cache boundaries.
- **HITL (human-in-the-loop)** first-class workflow separated from
  proposals (`ai_hitl_requests` table), with remote delivery via
  notification channels.
- **Session intelligence classifier** — `GET /api/v1/ai/sessions/:id/intelligence`
  returns health status + reason code; batch endpoint for dashboard views.
- **Operator inbox** at `/inbox` — discriminated-union read model of open
  HITL items, stuck/risky sessions, and failed proposals. Supports
  snooze on failed-proposal items.
- **Project digest** at `/digest` — groups recent sessions by cwd with
  daily cache invalidated on refresh.
- **Template distillation** — `POST /ai/templates/distill` produces a
  draft template with provenance for user review.
- **Launch recommendation** — `POST /launches/recommendation` returns an
  advisory suggestion; the existing validator remains authoritative.
- **Risk classes** — `GET/PUT /ai/risk-classes` configure what triggers
  `ask_on_risk` policy. Defaults cover destructive commands, credential
  references, and recent test failures.
- **AI diagnostics** — `GET /api/v1/ai/diagnostics` returns queue depth,
  flag state, and OTel configuration.
- **Structured `ai_metric` log events** on every wake enqueue and run
  completion. Opt-in OpenTelemetry forwarding via `AGENTPULSE_OTEL_ENDPOINT`.

#### Notification channels (Labs)

- Pluggable **NotificationChannelAdapter** interface with registry +
  dispatcher.
- **Telegram channel** with HMAC-verified webhook, enrollment via
  `/start <code>` deep link, QR code + copy-link UI, bot-identity + webhook
  health diagnostics, test message button, delivery stats, and inline
  documentation for env vars.
- First-class Telegram settings panel with full setup UX.

#### Labs gating

- Per-feature flags stored in a single `labs` settings row.
- Registry merges stored partial with defaults so new flags inherit
  sensible defaults (shipped features default on, experimental default off).
- `LabsBadge` surfaced on nav items and settings panels so users know
  what's experimental.

#### Observability & hardening

- Codex rollout observer — surfaces sessions even when hooks fail.
- Live LLM integration test runner (replaces the previous flaky hermetic
  pipeline test).
- Telemetry pipeline: Cloudflare Worker + D1 at
  `telemetry-agentpulse.xmojo.net` for anonymous usage data.

#### UI / UX

- **Top bar with Admin + User dropdowns** in the top-right, side nav
  focused on workflow (Dashboard, Sessions, Inbox, Digest, Templates).
- Session detail **AI tab** with HITL approval panel.
- **Settings page** AI watcher section.
- Session detail decomposition: `SessionHeader`, `ActivityTimeline`,
  `ControlHistory`, `InlineRename`, `SessionOverflowMenu`.
- Templates page decomposition: `TemplateList`, `TemplateEditor`,
  `TemplatePreview`, plus `HostCompatibilityPanel` and
  `RecentLaunchesPanel`.
- Markdown export for session transcripts.

### Changed

- **Session lifecycle** — `working` blocks `idle` / `completed` transitions.
  `completed` sessions reanimate when new activity arrives (sets
  `endedAt: null`). Stuck-working recovery after 60 minutes without events.
- **Architecture remediation** — removed `correlation-enricher` (5-line
  false abstraction), introduced pure `correlation-resolver` +
  `launch-dispatch.associateObservedSession`. Transcript round-robin
  worker (3 sessions/tick, 2s interval).
- Side nav no longer contains Setup / Hosts / Settings — those moved to
  the top-bar Admin + User dropdowns.

### Fixed

- Mobile hamburger menu z-stacking under sticky page chrome — the overlay
  now renders via `createPortal` to `document.body` to escape the Layout
  stacking context. Works around an iOS Safari sticky-inside-scroll bug.
- TopBar dropdowns painting under the SessionTabs strip — lifted TopBar
  to `relative z-30`.
- Mobile SessionDetail chrome compacted so messages have room.
- Relay template escaping in `scripts/setup.ts` (unescaped backticks in
  a template literal terminated the outer template early).

### Deployment

- Docker image: `192.168.10.222:30500/agentpulse:latest` (linux/amd64).
- Kubernetes manifests under `deploy/k8s/` target the `thor` cluster
  with Authentik SSO + Traefik IngressRoute.
- Local install: `docker run -d -p 3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true`.
- Remote hook relay: `curl -sSL https://server/setup-relay.sh | bash -s -- --key ap_xxx`.

[Unreleased]: https://github.com/jstuart0/agentpulse/compare/v0.2.0-pre.3...HEAD
[0.2.0-pre.3]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.3
[0.2.0-pre.2]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.2
[0.2.0-pre.1]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.1
[0.1.0]: https://github.com/jstuart0/agentpulse/releases/tag/v0.1.0
