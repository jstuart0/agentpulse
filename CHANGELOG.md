# Changelog

All notable changes to AgentPulse are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and — while the
project is still pre-1.0 — breaking changes land under the regular `Changed`
section with a `⚠ breaking` prefix so they're easy to spot.

## [Unreleased]

Ideas from a fork by @flexi767 (https://github.com/flexi767/agentpulse); re-implemented here.

### Added

- **Resumed Codex sessions are followed.** The supervisor's Codex observer now
  picks up a rollout file that was written to recently wherever it sits under
  `~/.codex/sessions`, so a session resumed from an older date directory is
  tracked instead of silently ignored. A long-dormant session that wakes up is
  discovered within about ten minutes. A resumed file seen for the first time
  is followed from its first line written in the last 15 minutes, not replayed
  from the start; if no recent timestamp is found it is followed from its end.
  The exclude rules are applied before anything is posted.
  `AGENTPULSE_CODEX_RESUME_WINDOW_HOURS` (default 24, `0` turns it off) sets how
  recently a file must have been written.
- **The Codex observer replays in bounded passes.** Each scan reads at most
  1 MiB and 500 lines per file and carries on from where it stopped on the next
  scan, and a scan never overlaps the one before it, so a large or long backlog
  can no longer stall the supervisor.
- **Codex hook setup merges into an existing `hooks.json`.** The setup scripts
  add AgentPulse's hooks alongside the ones already there instead of replacing
  the file, and refuse to touch a file they cannot reproduce exactly. On
  Windows the merge needs PowerShell 7.2 or later; on Windows PowerShell 5.1 an
  existing file is left alone and the installer says so. The Windows path has
  never been run on Windows.
- **Which machine a session runs on, for observed sessions too.** The relay and
  the supervisor's Codex observer now name their machine in an
  `X-AgentPulse-Host` header on the hooks they forward, and the server keeps it
  on the session (`reportedHost`, a new nullable column; two migrations). The
  session detail header and dashboard cards show it as "on <machine>", and the
  Overview labels it "Reported host". It is display only and self-declared, so
  nothing treats it as proof and no permission check reads it; a
  supervisor-launched session still shows its supervisor's host. Direct-mode
  hooks send nothing and show no host.

## [0.7.0] — 2026-10-03

### Added

- **Team mode and user ownership (AGEN-64).** An install now runs in one of
  two modes. Solo, the default, behaves as before. Team mode (switched in
  Settings → Team by an admin, or fixed with `AGENTPULSE_MODE`) records who
  owns each session, API key and host, adds admins and members, and checks
  the owner or an admin before a session is deleted, archived, renamed,
  pinned or its notes edited, before a key is revoked, and before a host is
  rotated or revoked. A session's owner is whoever's API key first reported
  it (the first write wins); a launched session is owned by whoever
  launched it. Team mode is attribution, not privacy: every signed-in
  member still sees every session, can prompt, stop or retry any managed
  session, and can launch on any host. New: `GET /instance`,
  `PUT /instance/mode`, `GET/POST/PATCH /users` and the disable, enable and
  reset-password routes, `GET /users/directory` (readable by `observe`
  keys), `PATCH /sessions/:id/owner`, `PATCH /api-keys/:id`,
  `PATCH /admin/supervisors/:id`, and an `owner` filter on
  `GET /sessions` and `GET /sessions/stats`. The dashboard gains
  Mine | Everyone, an Owner select, Group by (Project, User, Agent), owner
  chips, and server-counted tab badges. SSO users get an account on first
  sign-in; `AGENTPULSE_ADMIN_SSO_SUBJECTS` lists admin uids. New
  variables: `AGENTPULSE_MODE`, `AGENTPULSE_ADMIN_SSO_SUBJECTS`,
  `AGENTPULSE_SESSION_CREATE_LIMIT` (team mode: 120 new sessions a minute
  per person or ownerless key). With `AGENTPULSE_MODE=team` set in the
  environment, existing API keys with no owner and manage scope act as
  members until an admin keeps or assigns them, so automation using one for
  settings or key management gets `403 admin_required`. After switching,
  every existing host needs an owner (or its key kept as a service key), or
  hook events for dashboard-launched sessions from it are ignored.
  Offboarding means disabling the person in AgentPulse; removing them at
  the identity provider is not enough. See the README's "Teams" section and
  `deploy/k8s/RUNBOOK-secrets-rotation.md`. Migration: Postgres `0007` /
  SQLite `0006`.

- **Exclude rule: keep chosen directories out of AgentPulse (AGEN-63).**
  `~/.agentpulse/exclude` lists directories (one absolute path per line)
  whose sessions are never reported, checked on the user's own machine
  before anything is sent. Codex and Copilot hook commands, the relay and
  the supervisor apply it; an invalid rules file fails closed for each of
  them. `AGENTPULSE_SKIP=1` skips one run (Claude Code's hooks forward it as
  an `X-AgentPulse-Skip` header, which the server drops after
  authenticating). `agentpulse exclude add|list|check` manage and verify
  the rules; the Setup page has an "Exclude directories" card; the
  statusline, a marker file and the Hosts page say when rules are invalid.
  The server never learns what is excluded, only a host's invalid flag
  (`excludeRulesState` on hosts, migration Postgres `0009` / SQLite
  `0008`). Claude Code posting straight to the server does not apply path
  rules. Re-run setup for Codex: it asks you to re-approve the changed hook
  command. Windows (PowerShell) support is written but has not been
  executed on Windows. An older relay or supervisor ignores the rules.

- **Operational session state: WAITING / WORKING / IDLE / ERROR (AGEN).**
  Original feature contributed by [@Pawel0c0l](https://github.com/Pawel0c0l)
  — thank you! Sessions now carry two acknowledgement timestamps
  (`lastAgentTurnCompletedAt`, stamped on Stop; `lastUserAcknowledgedAt`,
  stamped on UserPromptSubmit and on acknowledging) and a derived
  `operationalStatus`, computed identically on the server and in the
  dashboard by the shared classifier in `src/shared/session-state.ts`. The
  dashboard shows four status cards (a single-select filter), and
  `GET /sessions/stats` carries the same four counts so they're correct
  beyond one page. A session you haven't looked at since the agent
  finished shows WAITING; opening it, or using the new "mark as seen"
  controls (per-card, or "mark all waiting as seen"), clears it. A failed
  session shows ERROR until acknowledged, at which point it's dismissed as
  completed. `POST /sessions/:id/acknowledge` is the new endpoint behind
  "mark as seen"; it only counts for the session's owner (or anyone, on an
  unowned session or with auth disabled).

- **Split-SQLite-database detection (hosts-visibility fix).** `GET
  /api/v1/health` now reports `instance: { dbFingerprint, dialect }` — a
  short, non-reversible fingerprint of the backing database (first 12 hex
  chars of a salted sha256 of the existing `installation_id`; never the raw
  id, and derived with a different salt than telemetry.ts sends, so it
  can't be correlated against a telemetry ping). On Postgres every replica
  shares one database, so this is always a single stable value — correct
  by construction. On SQLite, running more than one server instance (each
  gets its own independent local database file; SQLite is single-instance
  only — see CLAUDE.md "Single-replica constraint") produces more than one
  fingerprint. The dashboard now polls `/health` on load and every ~60s,
  tracks distinct fingerprints seen in the current browser session, and
  shows a persistent warning banner when it detects alternation between
  two or more (tolerating a single clean transition, e.g. a server
  restart). The server also logs a best-effort, heuristic warning once at
  boot when it detects SQLite running under an orchestrator that commonly
  scales to >1 replica (`ECS_CONTAINER_METADATA_URI`/`_V4` or
  `KUBERNETES_SERVICE_HOST` set). See the README "A host registered but
  doesn't appear on the Hosts page" troubleshooting entry and
  `deploy/k8s/README.md`'s "Detecting a split SQLite deployment" section.

- **Event retention enforcement (AGEN-24).** The `eventsRetentionDays`
  setting (Settings → Session Configuration → Event Retention) is now
  enforced by a periodic background pass (hourly by default; override with
  `AGENTPULSE_RETENTION_INTERVAL_MS`, clamped to [60s, 24h] — an
  out-of-range or non-integer value falls back to the 1-hour default with a
  warning) that deletes `events` rows older than the configured cutoff in
  bounded batches of 1,000 rows, yielding between batches so ingest is
  never blocked. **Off by default**: the setting has always existed but
  was never enforced before this release, so an upgrade does not start
  deleting anything — retention only runs once an operator explicitly sets
  `eventsRetentionDays` to a positive number of days (unset, `0`, or
  negative all mean disabled). The Settings UI field was changed from a
  misleading always-30 placeholder to a real 0-means-disabled value, and no
  longer writes on an unmodified blur. A new index,
  `idx_events_created_at_id` on `events (created_at, id)` (migration 0005),
  backs the batch-select query. Deleting from `events` fires the existing
  SQLite FTS/embeddings delete triggers, so `search_events_fts` and
  `event_embeddings` stay consistent automatically; the session row and its
  denormalized state (including `metadata.permissionWait`) are never
  touched by a retention pass. On Postgres (multi-replica capable), EACH
  BATCH runs in its own short transaction, re-acquiring a non-blocking
  `pg_try_advisory_xact_lock`; if the lock isn't held, the pass stops and
  is reported as skipped. SQLite deployments (single-replica) run
  unguarded. Every Postgres connection this app opens (main pool and
  migration client) now pins `connection: { TimeZone: "UTC" }`
  (`db/client.ts`'s `PG_CONNECTION_OPTIONS`) — `created_at` is TEXT
  rendered in the connection's `TimeZone` GUC, and the retention cutoff
  comparison is a lexicographic UTC string compare, so an unpinned
  connection on a non-UTC-default Postgres server could judge rows as
  older than they are by the server's offset (in the worst case, a row
  written moments ago could look older than a tight cutoff). **Upgrade
  note**: this pin only affects new connections going forward — if your
  Postgres server's default timezone was not UTC before upgrading, rows
  already written keep their local-time-with-offset text; see
  `deploy/k8s/README.md`'s "Event retention (AGEN-24)" section for the
  precise boundary condition this leaves. After a SQLite pass that deleted
  rows, `PRAGMA incremental_vacuum` runs automatically if the database was
  created with `auto_vacuum = INCREMENTAL`; existing installs
  (`auto_vacuum = NONE`) need a one-time manual `VACUUM` during a
  maintenance window to reclaim space — see `deploy/k8s/README.md`.
  `GET /api/v1/health` now includes a `retention` field with the last
  pass's `rowsDeleted`/`durationMs`/`disabled`, a separate `lastSkip` field
  for the most recent skipped pass, and the next scheduled tick.

### Changed

- **Counts follow the scratch toggle.** "Show scratch workspaces" now
  applies to every number on the dashboard (status cards, tab badges,
  totals), not only the grid; while it is off, how many scratch sessions
  are left out is shown beside it. This applies to solo installs too.
- **The Idle tab is gone.** Idle sessions are listed under Active, and
  the Idle status card filters to them. The tabs are Active, Completed,
  Archived and All (All leaves archived sessions out, which it now says).
- **Accounts an admin creates must change their password at first
  sign-in.** The password the admin hands over is temporary: until the
  person replaces it, their API keys get `403 password_change_required`
  on every route except hook ingestion, which keeps accepting events. This
  applies on solo installs too.
- **Signup is stricter.** Creating an account through `/auth/signup`
  refuses a request from a foreign `Origin`, and once any user exists it
  needs a signed-in human admin (an API key can't).
- **Open dashboard tabs are kept per person.** On upgrade, the tabs the
  browser had open move into the first person who signs in (and stay with
  a solo install that signs in); after that each person gets their own.
- **Channel management is admin-only in team mode, enforced by the server.**
  Creating, deleting, configuring and testing a notification channel, and
  the Telegram bot setup, return `403 admin_required` for a member; the
  Team and Settings pages already hid them. Solo is unchanged.
- **Enrolling a host in team mode needs someone to own it.** A key with no
  owner that isn't kept as an admin service key gets `403 admin_required`
  from `POST /admin/supervisors/enroll`. Solo is unchanged.
- **Malformed request bodies answer 400.** `PUT /sessions/:id/pin`,
  `/archive`, `/notes`, `/rename` and `/claude-md` now return
  `400 { error: "invalid_body" }` for a body that isn't a JSON object with
  the right field types. Before, some answered 500, and some changed data
  silently: a notes body without `notes` wiped the notes, and
  `"archived": "no"` archived the session. `GET /sessions/:id/timeline`
  now validates `limit` and `offset` (400 `invalid_limit` /
  `invalid_offset`).
- **Live updates with authentication off.** With `DISABLE_AUTH=true`, the
  WebSocket accepts a connection only when the request's host is a
  loopback address or one named by `PUBLIC_URL`. Reach such an install on
  another address and set `PUBLIC_URL`, or the dashboard polls instead.
- **A launch refusal for a trusted-roots violation is generic while an
  exclude file exists.** The supervisor's `path_outside_trusted_roots`
  error no longer names the path or the reason, so a refusal doesn't reveal
  whether a directory is excluded. The host's own log has the detail.
  Hosts with no exclude file keep the old message.
- **Postgres migrations `0007` and `0009`.** `0007` (user ownership) adds
  15 nullable or defaulted columns, plus `idx_sessions_owner_last_activity`,
  `idx_api_keys_owner` and a unique `idx_users_provider_subject`. None is
  built `CONCURRENTLY`: the sessions index takes a `SHARE` lock, so hook
  writes wait while it builds. On a large table, pre-create it first with
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; the migration then skips it.
  `0009` adds the nullable `supervisors.exclude_rules_state`. Both run in
  band under the advisory lock; see `deploy/overlays/postgres/README.md`.

- **Postgres event/session search is now index-backed (AGEN-27).** Migration
  `0006` adds `pg_trgm` GIN indexes covering every column/expression
  `PostgresSearchBackend`'s `ILIKE '%term%'` queries already OR together —
  match semantics are unchanged (still the same OR-across-columns ILIKE);
  searches that previously did a sequential scan of the whole `events`
  table are now served from the index when pg_trgm is available. The
  `event_type IN (...)` restriction is rendered as literal SQL text (a
  hardcoded, compile-time-known list, never user input) rather than bound
  parameters — a bound list is opaque to Postgres's planner once it plans
  generically, which can silently drop all six events indexes in favor of
  a sequential scan. `searchSessions` runs with server-side prepared
  statements explicitly disabled (postgres-js per-query `prepare: false`,
  global client config untouched), so every execution sees the real bound
  values on every plan.

  `searchEvents` needed more: an earlier revision fenced the filter in a
  `MATERIALIZED` CTE, which forces Postgres to fully materialize every
  matching row before `LIMIT` — correct for a rare term, but a common one
  (~50% selectivity) regressed 0.18ms -> 1.8s at 1M rows (10,000x+, ~50MB
  of temp spilled per query) by defeating early-`LIMIT` short-circuiting;
  removing the fence (disabling prepare instead, same as `searchSessions`)
  fixed that. But further investigation (EXPLAIN ANALYZE against a
  worst-case fixture — a genuinely *unique* match at the very end of scan
  order, not a spread-out one) found the planner never picks the trigram
  index plan for this query shape at any selectivity: a rare/unique term
  degrades toward a near-full-table scan instead, measured 892-926ms at 1M
  rows and worse as `events` grows — a Postgres cost-misestimation for
  opaque `ILIKE` patterns, not a missing index (forcing the planner off
  the ordering index on the same data proved the trigram plan is
  available for a rare/unique term). `searchEvents` now runs an adaptive
  two-plan strategy: Plan A is the unprepared query inside a transaction
  with a 150ms `statement_timeout`; if canceled (SQLSTATE 57014), Plan B
  re-runs the identical query in a fresh transaction with
  `enable_indexscan`/`enable_indexonlyscan` off, forcing the trigram path,
  with a generous 10s timeout. Plan B's own cost scales with the size of
  the matched set, not just table size (~400ms measured at 500,000
  clustered matches) but stays bounded by the query's top-N heapsort
  rather than degrading further. Both `SET LOCAL`s are transaction-scoped
  and never leak onto a pooled connection. Pagination is identical either
  way (same `ORDER BY`/`LIMIT`/`OFFSET`, enforced by Postgres regardless
  of physical plan). The events-side
  indexes are partial (`WHERE event_type IN (...)`), restricted to the
  same event types SQLite's FTS5 indexes (`FTS_INDEXED_EVENT_TYPES`), so
  the two dialects search the same population. `pg_trgm` requires `CREATE
  EXTENSION`, which some managed Postgres providers restrict — the
  migration feature-detects this and degrades to a `WARNING` plus the
  existing sequential-scan path when the extension can't be installed,
  and separately when an index build fails partway through — neither
  aborts the migration or blocks boot. On an existing install with
  `events` already over 100,000 rows (an ANALYZE-maintained estimate; a
  never-analyzed table's -1 "unknown" sentinel is treated the same as
  "too large" and skips, fail-safe, rather than the -1 accidentally
  passing the size check and locking for the full build), the automatic
  build is skipped to avoid a multi-second `SHARE` lock on
  `sessions`/`events` at boot; `GET /api/v1/health`'s new `searchIndexes:
  { present, missing[] }` field (checked once at boot, and not fooled by
  an index Postgres marked `INVALID` after a failed `CONCURRENTLY` build)
  reports whether the trigram indexes are actually in place, alongside a
  startup log line when they're not. See `deploy/k8s/README.md`'s
  "Upgrading to migration 0006" section for the `CREATE INDEX
  CONCURRENTLY` out-of-band path (including the index-size note —
  roughly 55-112% of the `events` heap, per percy's measurements — and a
  reminder to run `ANALYZE events;` after any bulk import or restore).

### Fixed

- **A refused admin action could roll back hook writes (SQLite).** The
  admin lock on SQLite is an open transaction on the one shared
  connection, and a hook write that landed inside it was lost with it when
  the action was refused (last admin, undecided key at the mode switch,
  disabled owner). A locked body now cannot be interleaved with: the lock
  waits a turn before it starts, its body only awaits database calls, and a
  body that yields fails tests and logs `admin_lock_body_yielded`.
- **An open tab learns about role and mode changes made elsewhere.** The
  dashboard re-checks who you are after a refusal that names your role or
  ownership, when the tab comes back to the front and when the live
  connection reconnects, at most once every few seconds. A different
  person signed in from another tab resets the page; a changed role or
  mode updates it.
- **The dashboard returns to Everyone when the instance goes back to
  solo.** Before, it stayed on Mine with no switch to change it.
- **A solo install whose sessions are all scratch keeps its dashboard.**
  The first-run screen shows only when there are no sessions at all.
- **A first load that only `/auth/me` fails** shows the "Can't reach the
  server" notice and keeps retrying, instead of staying on the loading
  screen.
- **Search results name the owner** of a session hit (`ownerUserId`,
  `ownerKind`), on both search backends.
- **A healthy host's heartbeat no longer writes the exclude flag.**
- **Smaller team-mode fixes in the dashboard.** Change-owner dialogs list a
  disabled current owner ("name (disabled)") and keep Save off until the
  owner changes; the Team list and the owner chips use the same initials; a
  session you don't own shows its notes as text, with the reason and no
  editor; group-by-User headers show an owner's working and waiting counts
  only on the Active tab (otherwise they're counted from the cards shown);
  the Setup page's Codex check asks for your own sessions in team mode; a
  search no longer makes the list refetch on every count refresh; Try again
  after a partly failed "Existing items" step doesn't resend what already
  went through; switching back to solo offers Try again if the people list
  fails to load; session-page pills and the Stop and Dismiss error buttons
  reach 4.5:1 contrast in the light theme; the first-run link to the
  exclude card scrolls clear of the header and focuses its heading; the
  Hosts notice for an invalid exclude file says to run
  `agentpulse exclude check` on that machine.

- **Installation id minted twice on a fresh database.** Concurrent first
  requests each created an id and the last write won, so a new install
  briefly reported two database fingerprints and the dashboard raised its
  split-database warning. The id is now minted once.
- **The stale-session sweep now tells open dashboards.** Sessions the sweep
  idled or completed used to change in the database without a live update,
  so lists and count badges disagreed until a reload. Each changed session
  is now broadcast.

- **Hosts page silently rendered an empty list when the list request
  failed (hosts-visibility fix).** `GET /api/v1/admin/supervisors` failing
  (an expired session, an under-scoped API key, a network error) used to
  render identically to a server with zero registered hosts — a
  registered-but-invisible host went unnoticed because the page never
  distinguished "no hosts" from "couldn't check." The Hosts page now shows
  a distinct error state with the status code and server message when
  available (e.g. "Couldn't load hosts: 403 insufficient_scope") and a
  Retry button; this takes priority over any stale supervisor list still
  on screen. The enrollment/revoke/rotate actions on the same page now
  surface the same status-code detail instead of a generic "Failed to
  ..." message.

- **Test suite could write to the developer's real home directory.** A
  test run previously wrote a `supervisor.json`, appended to `.zshrc`, and
  created `~/.agentpulse/env` in a real developer home instead of a
  sandboxed temp directory. Root cause was two Bun-specific gaps beyond
  each test's own `process.env.HOME` override: Bun's `os.homedir()`
  doesn't track a `process.env.HOME`/`USERPROFILE` mutation made after the
  process starts (Node's does), and `Bun.spawn`/`Bun.spawnSync` default to
  a snapshot of the process's own OS-level startup environment when `env`
  is omitted, not a live read of `process.env` — a subprocess spawned with
  no explicit `env` (e.g. `src/supervisor/config.ts`'s
  `captureExecutableVersion`, which shells out to the real
  `claude`/`codex` CLI when a config under test leaves those commands
  unset) silently used the developer's real environment regardless of any
  in-test override. `bunfig.toml`'s `[test] preload`
  (`src/server/db/test-env-defaults.ts`) now redirects
  `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR`
  to a fresh per-process temp directory before any test file's own imports
  run, and patches both `node:os`'s `homedir()` and `Bun.spawn`'s/
  `Bun.spawnSync`'s default `env` to match — closing the gap structurally
  for every test file rather than depending on each one remembering its
  own override. `src/server/db/test-home-sandbox.test.ts` guards both
  findings; `src/supervisor/config.test.ts`'s executable-capability tests
  were also hardened to pin `claudeCommand`/`codexCommand` to
  guaranteed-nonexistent paths so they never shell out to a real installed
  CLI in the first place. See `TESTING.md`.

- **Backup sidecar livelock under concurrent writes (AGEN-54).**
  `deploy/k8s/scripts/run-backup.sh` used sqlite3's `.backup` command, which
  restarts its page copy whenever a WAL checkpoint lands mid-copy — under
  sustained write load it can livelock indefinitely instead of finishing (one
  production run stalled at a fixed offset for 20+ minutes; backup history
  showed 12-15h completions). The script now snapshots with `VACUUM INTO`
  (a single bounded read transaction, read-only-safe against the live DB),
  verifies the output with `PRAGMA integrity_check` before promoting it, and
  checks free space up front. Naming, compression, retention
  (`scripts/retention.sh`), and logging are unchanged.
  Follow-up hardening from review: a signal trap now removes the in-flight
  `.tmp` file on SIGINT/SIGTERM, and a startup sweep clears any `.tmp` older
  than 60 minutes left behind by an untrappable SIGKILL; the promotion
  rename failure is now handled explicitly (exit 7) instead of falling
  through to an unhandled `set -e` exit; a checksum failure is now
  non-fatal, matching the existing row-count check; the VACUUM INTO
  connection sets `busy_timeout=5000`; and the sidecar logs its sqlite3
  version at the start of every run.

### Security

- **Launch-correlation squatting.** A `manage`-scoped caller (REST `POST
  /api/v1/launches` or MCP `launch_agent`) could previously set a launch's
  correlation id to an existing or guessed-future session id. On that
  session's next `SessionStart` event, the session would be silently
  attached to the attacker's launch instead of its real one, handing the
  attacker's supervisor ownership of record — making the session's queued
  prompt/stop control actions claimable by the attacker's supervisor
  instead of the legitimate one. The server now always mints the
  correlation id itself (`createValidatedLaunchRequest`) and ignores any
  caller-supplied value; the no-supervisor hook-path correlation resolver
  additionally refuses to attach a pending launch to a session that's
  already managed under a different launch, or that already existed
  before the launch was created; and `queuePromptAction`/
  `queueStopAction`/`retryLaunchForSession` now assert the resolved
  launch's claimant matches the session's actual owner of record before
  trusting its data or routing a new action to it. No legitimate launch
  flow (template launch, retry, AI-initiated launch, MCP's
  `preview_template` → `launch_agent` pass-through) ever depended on a
  caller-chosen correlation id being honored. The resolver's chronology
  comparison normalizes both sides to an instant (`parseDbTimestamp`)
  rather than comparing the stored strings directly, since a raw string
  comparison can silently flip the wrong way between the SQLite and
  Postgres default timestamp formats.
- **Supervisor and installer secret files are now written 0600, not 0644
  (AGEN-21).** `~/.agentpulse/supervisor.json` (the supervisor credential /
  enrollment token), `~/.agentpulse/.env.local` /
  `<install-dir>/.env.local` (`AGENTPULSE_INITIAL_API_KEY`) were written
  with the OS-default create mode under a typical umask — world-readable,
  any local user could read the credential and act as that supervisor.
  `saveSupervisorConfig` (`src/supervisor/config.ts`) and both local
  installers (`scripts/install-local.sh`, `scripts/install-local.ps1`) now
  write through the same no-follow, 0600 primitive already used for
  `hook-auth-header` (`src/shared/private-file.ts`'s
  `writePrivateFileSyncNoFollow` in TS; `ap_write_private_no_follow` in
  bash; `Write-ApPrivateFile`/`Write-ApPrivateJsonFile` — ACL-narrowed to
  the current user — in PowerShell), refusing rather than following a
  symlink at the destination. Existing installs are self-healed: the
  supervisor now tightens an over-permissive `supervisor.json` to 0600 on
  startup (logging once), refusing — not chmod'ing — if the path is a
  symlink. Both no-follow write helpers were themselves hardened against a
  predictable temp-file name (`ap_write_private_no_follow`/
  `ap_write_no_follow` now use `mktemp`'s unguessable `XXXXXX` suffix
  rather than a guessable `.$$.tmp`), `tightenPrivateFilePermissionsSync`
  refuses a hard-linked path, and the supervisor's startup permission fix
  never crashes the process if it loses its internal TOCTOU race.
- **API key exposure in installer commands and config files (AGEN-49,
  reviewed by xander).** v0.6.0 moved the key out of shell rc files into
  `~/.agentpulse/env` (mode `0600`) and added `AGENTPULSE_KEY` env-var
  support, but several residual exposure paths remained:
  - The dashboard's default local-install command, both README install
    snippets, `install-local.sh`'s printed fallback instructions, and
    SetupPage's per-agent auth-step commands (claude_code, codex_cli,
    copilot_cli — POSIX side) all passed the key as `--key ap_...` or
    embedded it literally in copy-paste text, landing in `ps` and/or shell
    history. All now read the key at a hidden terminal prompt instead:
    POSIX `printf 'AgentPulse API key: '; read -rs VAR; echo` (not
    `read -rsp` — `-p` means "coprocess" in zsh, macOS's default shell, so
    a pasted `-rsp` silently misbehaves there), guarded by
    `[ -n "$VAR" ] &&` so a blank answer skips the install instead of
    running curl unauthenticated. codex_cli/copilot_cli's PowerShell
    variant now reads the key via `Read-Host -AsSecureString` +
    `SecureStringToBSTR`/`PtrToStringBSTR`/`ZeroFreeBSTR` and adds the
    hard-link check `New-ApHookAuthHeaderFile` already has but this
    displayed snippet didn't. Documented as a trade-off for scripted/
    non-interactive installs, which can still set `$AGENTPULSE_KEY`
    beforehand (visible in shell history).
  - Added execution tests that actually run the rendered onboarding
    command and the setup-steps POSIX snippets under every shell present
    (bash, zsh, sh), feeding the key on stdin and using a stub `curl` —
    catching the zsh `read -rsp` regression a text-pattern check alone
    would have missed.
  - **Claude Code's silent-401 trade-off, resolved deliberately.** Claude
    Code's native HTTP hook expands `$AGENTPULSE_API_KEY` from its own
    process environment, not the shell that launched it — a GUI, IDE, or
    stale-terminal launch never sources `~/.agentpulse/env`, so an
    env-var-only header 401s silently there. **User scope**
    (`~/.claude/settings.json`, the default for `/setup.sh`,
    `agentpulse setup`, `install-local.ps1`, and `setup-hooks.sh`'s default
    `--scope global`) now embeds the literal key again, made acceptable by
    tightening the file to mode `0600` (POSIX) / a single-ACE user-only ACL
    (Windows) with a no-follow write (a symlinked `settings.json` is
    refused, not written through) — merging into an existing file preserves
    every other key already in it. **Project scope**
    (`setup-hooks.sh --scope project`, a repo's own `.claude/settings.json`,
    which may be committed) never gets a literal key — it keeps the
    `$AGENTPULSE_API_KEY`/`allowedEnvVars` form unconditionally, with a
    printed reminder to fully restart Claude Code (a GUI/IDE-launched
    instance may not see a shell-exported env var).
  - Regression coverage installs each of claude_code/codex_cli/copilot_cli
    (including `--scope project`) and the served `/setup.sh` against a
    temp `$HOME`, then scans every resulting file for the literal key —
    asserting it appears only in `hook-auth-header` and `env` (always,
    mode `0600`), and in `settings.json` only for user/global scope (also
    mode `0600`) — never in any project-scope file, at any permission.
    Also covers: an existing `settings.json`'s other keys survive the
    merge, and a symlinked `settings.json` is refused.
- **First-run signup on an SSO-fronted install.** When a forwardauth
  identity provider is configured (`FORWARDAUTH_TRUST_SECRET` set), signing
  in via SSO never creates a local account, so the local user count can
  stay at zero indefinitely. Previously, first-run signup's own gate
  (`AGENTPULSE_ALLOW_SIGNUP`, off by default) was the only thing standing
  between an anonymous visitor and self-registering a local admin on such
  an install — and unlike a non-SSO install, where the first real signup
  closes the window for good, an SSO-fronted install's local count never
  grows on its own, so a stray `AGENTPULSE_ALLOW_SIGNUP=true` left over
  from testing stays open forever instead of closing itself. Signup is now
  **closed by default** whenever a forwardauth provider is configured:
  boot logs one line stating that. Set `AGENTPULSE_ALLOW_SIGNUP=true`
  explicitly if you want local signup available alongside SSO — boot then
  logs a separate warning that it will stay open indefinitely for exactly
  the reason above, so the choice to keep it open isn't a silent one. The
  documented, recommended way to create a
  local admin on an SSO install remains `AGENTPULSE_LOCAL_ADMIN_USERNAME` /
  `AGENTPULSE_LOCAL_ADMIN_PASSWORD`, which is unaffected either way.
  Installs without forwardauth configured are unaffected.
- **Login timing for a disabled user.** `verifyCredentials` returned
  immediately for a disabled account, skipping the password-hash cost that
  every other failure path (unknown username, wrong password) pays — a
  timing side channel that could distinguish "this username exists but is
  disabled" from "wrong password." The disabled branch now runs the same
  dummy password verify as the other failure paths.
- **Forwardauth provider label.** `FORWARDAUTH_PROVIDER` is encoded
  directly into the synthetic SSO username as `sso:<provider>:<subject>`. A
  provider value containing `:` would make that encoding ambiguous; an
  empty or whitespace-only value would collide across installs. The server
  now refuses to boot with a clear error if the configured provider is
  invalid.

### Deprecated

- The following aliases were scheduled for removal in this release. They
  remain supported in 0.7.0 and **will be removed in v0.8.0**. Migrate now:
  - `AGENTPULSE_AUTHENTIK_TRUST_SECRET` env var → use `FORWARDAUTH_TRUST_SECRET`.
  - `agentpulse-strip-client-authentik` Traefik middleware → use
    `agentpulse-strip-client-forwardauth`.
  - `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` → see `deploy/k8s/FORWARDAUTH.md`.
  - The `"authentik"` auth-source value → `"forwardauth"`.

### Upgrade notes

- **Migrations run at boot and are additive.** SQLite `0005`–`0008` and
  Postgres `0005`–`0009` apply automatically on first start. Nothing is
  dropped or rewritten.
- **Postgres owner index.** Postgres `0007` builds
  `idx_sessions_owner_last_activity` without `CONCURRENTLY`, which takes a
  `SHARE` lock on `sessions` while it builds, so hook writes wait. On a
  large table, pre-create it first with `CREATE INDEX CONCURRENTLY IF NOT
  EXISTS`; the migration then skips it. See `deploy/overlays/postgres/README.md`.
  The `pg_trgm` search indexes (`0006`) have their own out-of-band path in
  `deploy/k8s/README.md` ("Upgrading to migration 0006").
- **The instance stays in solo mode until you switch it.** Upgrading does
  not turn on team mode; an admin switches it in Settings → Team, or set
  `AGENTPULSE_MODE`.
- **Re-run relay setup on each machine** to pick up the current relay and
  hook shape (`setup-relay.sh`; re-running is safe and keeps your key and
  port). **Re-approve the Codex hooks** afterwards: the hook command
  changed, so Codex asks you to trust it again (`/hooks` inside Codex).
- **Exclude rule on Windows.** The PowerShell support for the exclude rule
  has not been tested on Windows.

## [0.6.0] — 2026-09-29

### Added

- **Copilot CLI support (AGEN-13) — labeled "contract not yet
  verified against a live Copilot CLI" until a live-payload diff passes.**
  AgentPulse now observes GitHub Copilot CLI sessions: 10 registered hook
  events (`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `postToolUse`,
  `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`,
  `preCompact`, `errorOccurred` — `preToolUse`/`permissionRequest` are
  deliberately excluded, Copilot's fail-closed paths) posted as detached
  `command` hooks to `~/.copilot/hooks/agentpulse.json`, written only when
  `copilot` is detected on `PATH` or `~/.copilot` exists. Copilot is
  observed only (AgentPulse can't launch or steer it), shown with a
  dedicated badge and an "Observed only" hint on the session detail page
  and the Setup page. The canonicalizer accepts both Copilot's native
  camelCase payload shape and a Pascal/snake_case mirror, and caps
  `toolArgs`/`toolResponse` at 64 KiB. Codex CLI's own hook-event set also
  gains `SessionEnd` and `Interrupt` (10 → 12 total events); the
  Claude/Codex/Copilot event counts are now 16/12/10.
  **Known version-skew gap**: an `agentpulse-mcp` 0.2.0+ client's
  `list_sessions` can filter by `agent_type: "copilot_cli"`, but a server
  *older than this release* has no rows with that agent type and predates
  the unrecognized-`agent_type` 400 below — it silently returns zero
  sessions rather than an error, which can look identical to "the filter
  didn't apply." Upgrading the server to this release or later closes the
  gap (see "Fixed" below); there's no client-side way to detect an older
  server's feature set in the meantime. See
  `packages/agentpulse-mcp/README.md`'s Hardening roadmap.
- **MCP server (AGEN-12)** — `agentpulse mcp serve` exposes AgentPulse over the
  [Model Context Protocol](https://modelcontextprotocol.io) for external AI
  coding agents (Claude Code, Codex CLI, or any MCP-compliant client): 11
  observability read tools (sessions, search, timelines, AI digest/status/
  intelligence) plus orchestration tools (launch agents, prompt/stop/retry
  live sessions, template CRUD, HITL/inbox decisions), gated by a new
  `observe`/`manage` API key scope model. `observe` is provably secret-free
  at the REST boundary — reads that carry env vars, launch specs, claim
  tokens, or operator-authored project metadata are excluded from that tier
  and require `manage`. `agentpulse mcp install` mints a scoped key (or
  reuses one, with a scope preflight) and prints ready-to-paste Claude Code
  and Codex CLI configuration; the default is observe-only, with
  `--orchestrate` required for a manage-capable key plus a printed warning
  about what that grants. See [docs/MCP.md](docs/MCP.md) for the full tool
  catalog and a security section covering host-side confirmation limits
  (Codex CLI does not honor Claude Code's `_meta` confirmation hint).
- **`/health` dedup and oversize-drop counters (AGEN-16)** — `eventsDeduplicated`
  (an object with `deliveryRetry`, `toolUseRetry`, `contentWindow`, and
  `authority` counts, explaining *why* a dropped delivery was dropped),
  `legacyObserverDeliveries` (deliveries from a not-yet-upgraded Codex
  observer — see "Changed" below), and `oversizeDropped` (hook deliveries
  dropped for exceeding the request-body cap).
- **`X-AgentPulse-Delivery-Id` / `X-AgentPulse-Origin` request headers (AGEN-16)**
  on `POST /api/v1/hooks`. A caller that can retry a delivery (a relay, the
  Codex observer) stamps `X-AgentPulse-Delivery-Id` with a stable id for that
  delivery so a retry dedupes instead of storing a second copy;
  `X-AgentPulse-Origin: codex-observer` identifies deliveries from
  AgentPulse's own Codex rollout-file observer. Both are optional — an old
  or third-party caller that omits them falls back to the previous
  best-effort behavior.
- **`AGENTPULSE_CODEX_OBSERVER=off` (AGEN-16)** — environment variable for the
  local supervisor. Disables the Codex-observer fallback entirely, for hosts
  where native Codex hooks are already installed and working.
- **Per-session native-hook marker (AGEN-16)** — a marker file at
  `~/.agentpulse/codex-native/<session_id>`, written by AgentPulse's own
  hook-install tooling, lets the Codex observer detect that native Codex
  hooks already cover a given session and stand down for it instead of
  posting a second copy of every event. A missing marker means the observer
  posts (fail-open: a possible duplicate, never a lost event).
- **`GET /api/v1/projects/summary` + `list_projects_summary` MCP tool** — an
  observe-safe project list: `id`, `name`, `defaultAgentType`, `defaultModel`,
  `defaultLaunchMode`, and `githubRepoUrl` reduced to `origin`+`pathname`
  (userinfo, query string, and fragment all stripped). Registered ahead of
  `/projects/:id` so `summary` is never captured as an `:id`. The full-detail
  `GET /api/v1/projects` (and its `list_projects` MCP tool) remain
  `manage`-scoped — that DTO still carries arbitrary operator-set
  `notes`/`metadata` and an unredacted `githubRepoUrl`.
- **Relay diagnostics, status file, and statusline hint.** `GET /relay/diagnostics`
  on the local relay now reports `auth` (the key's scopes and any missing
  ones), `sync.codexNames`/`sync.claudeMd` status, `drift.relay`/
  `drift.statusline` (`ok`/`outdated`/`unknown`/`missing`, comparing your
  installed copy's checksum against the server's, via the new `/health`
  `clients` field below), `agents.codex_cli.status` (`hooks_not_firing`
  when the relay has evidence Codex has been active but no Codex hook has
  ever arrived — almost always the un-trusted-hooks gap on Codex 0.145+),
  and the hook queue depth. Whenever something needs attention, the relay
  writes one line to `~/.agentpulse/status`, which `scripts/statusline.sh`
  renders as a dim `· agentpulse: …` hint next to the session name in
  Claude Code's statusline. See README's "Checking on the relay" section.
- **`/health` `clients`** — checksums of the relay and statusline scripts
  this server ships (hashed from the same strings `/setup-relay.sh` splices
  into an install), so a running relay or statusline can detect drift
  against the server it's talking to without re-downloading anything.
- **Name-pin display and reset.** A session's manually-renamed state now
  reads "Renamed by you" (instead of the previous "Pinned by you", which
  collided with the unrelated grid-pin feature) in the session detail
  header, with a tooltip explaining that agent-suggested names won't
  replace it. A "Use agent name" button clears the pin and adopts the
  agent's current suggested name.
- **Setup page: relay card.** The Setup page now offers a "Use the relay
  instead of the manual hook steps" card for agents on other machines: it
  mints a scoped relay key (Hook ingest + Observe) with one click and shows
  the exact `setup-relay.sh` command to copy, including a
  `--codex-names agentpulse` checkbox for switching Codex's name policy.
- **First-run "where do your agents run" step.** `FirstRunWelcome` now asks,
  as its first step, whether agents run on this machine or elsewhere, and
  mints an API key scoped for that choice (ingest-only for direct hooks on
  this machine, ingest+observe for a relay on another machine) rather than
  a one-size-fits-all key.

### Changed

- ⚠ breaking — **Codex hooks are regenerated as `command` handlers.** Re-run
  the setup or relay installer, then run `/hooks` inside Codex once to trust
  the new entries — Codex 0.145+ silently skips untrusted hooks. See
  README's "Codex/Copilot command hooks" section for why HTTP-type hooks
  were dropped in favor of a detached shell command.
- ⚠ breaking — **`setup-relay.sh` requires a key with Hook ingest + Observe**
  (previously ingest-only was enough). The installer refuses a key missing
  Observe; pass `--allow-missing-observe` to install anyway with name/
  CLAUDE.md sync turned off.
- ⚠ breaking — **The relay rejects browser-origin requests.** Any request
  to the local relay carrying an `Origin` header, or a non-loopback/wrong-
  port `Host` header, is rejected with `403 { "error":
  "relay_rejects_browser_requests" }` instead of being proxied — a
  same-origin page in a browser tab can no longer use the relay's lent API
  key to reach the remote server.
- ⚠ breaking — **Codex thread-name sync is agent-configurable; dashboard
  renames now win by default.** A manual dashboard rename is written into
  Codex's own `session_index.jsonl` (so `/resume` shows it), and Codex-side
  renames no longer silently override a name you set on the dashboard — use
  "Use agent name" to pull Codex's name back. New relay option
  `--codex-names agentpulse|codex` (config `codex_name_policy`, default
  `codex`, the previous pull-based behavior): under `agentpulse`, every
  Codex session's dashboard name is pushed into Codex and Codex-side
  renames never reach the dashboard. To protect against a runaway rename
  loop, the relay pushes a given session's name at most 3 times an hour; a
  4th rename within that hour reaches Codex up to 60 minutes late (shown as
  `push_suppressed` in diagnostics).
- ⚠ breaking — **`PUT /api/v1/sessions/:id/native-name` accepts `ingest`-scoped
  keys** (previously `manage`-only) and is now rate-limited with a real
  `429`, unlike the hook-ingest firehose's always-`200` contract.
- ⚠ breaking — **Served installers (`/setup.sh`, `/setup-relay.sh`,
  `/install-local.*`) ignore the `Host` header's hostname**, using only its
  numeric port for same-machine installs; the server address for a remote
  relay install comes solely from `PUBLIC_URL`, never from a request
  header. `/setup-relay.sh` now returns `503` (with a message to set
  `PUBLIC_URL`) for any non-loopback request when `PUBLIC_URL` isn't
  configured, instead of guessing an address from the request.
- ⚠ breaking — **Async/detached hook events observe a 30-second terminal
  latch and a closed-turn rule.** Once a `SessionEnd` completes a session,
  a late-arriving event (other than a real `SessionStart`/
  `UserPromptSubmit` resume) within 30 seconds is still stored and
  broadcast but no longer reopens the session's status, `endedAt`, or
  `isWorking`; a `Stop`/`Interrupt` closes its `turn_id`, and a
  late-arriving `PreToolUse` for that same turn no longer reopens
  `isWorking` either. This bounds the delivery-order tolerance needed for
  Codex's detached command hooks, whose POSTs can interleave with logical
  turn order.
- ⚠ breaking — **Direct-install command hooks (Codex, Copilot) refuse to
  write when they can't confirm whether the server requires a key.** Before
  writing any hook, the installer probes `/api/v1/auth/me`. With a key
  supplied, the probe is informational only. With no key, it proceeds only
  on a confirmed `disableAuth: true`; otherwise it exits non-zero and
  writes nothing (previously it would write hooks that silently 401
  forever). Pass `--no-auth-check` to skip the probe and install anyway.
  Direct command hooks also now require **curl >= 7.55** and refuse to
  write below that floor — older curl silently sends no auth header at all
  for the `-H "@file"` form these hooks use.
- ⚠ breaking — **The API key is no longer written into shell rc files.**
  `claude_code` installs now write the key to a new `~/.agentpulse/env`
  file (mode `0600`) and add a key-free, idempotent source line to
  `.zshrc`/`.bashrc`/`.profile`; `codex_cli`/`copilot_cli` installs make no
  profile write at all (they already authenticated via the `0600`
  `~/.agentpulse/hook-auth-header`). An existing plaintext
  `export AGENTPULSE_API_KEY=...` line from an older install is left alone
  but the installer prints a warning and the exact `sed` command to remove
  it.
- **`GET /api/v1/sessions?fields=` opt-in narrow projection** — a
  comma-separated field list (used by the relay's per-tick Codex-name
  paging) that returns lightweight summary rows with no `total` count. An
  unrecognized field name 400s rather than silently falling back to full
  rows. Omitting `fields` is unchanged. Backed by a new
  `(agent_type, last_activity_at)` index (SQLite/Postgres migration
  `0004`) — see "Upgrade notes" and `deploy/k8s/README.md` for the
  Postgres index-build note.
- **Removed `scripts/codex-hook.sh`**, the old per-event Codex hook shim
  superseded by the shared command-hook generator. The setup and relay
  installers delete `~/.agentpulse/codex-hook.sh` on the next run if an
  older install left one; delete it by hand if you're not re-running the
  installer.
- **MCP package consolidated into this repo, published as `@agentpulse/mcp`**
  — `packages/agentpulse-mcp/` (directory and `agentpulse-mcp` binary name
  unchanged) is now the single source of truth for the MCP server package.
  It publishes to npm as `@agentpulse/mcp` (the unscoped `agentpulse-mcp`
  name is blocked by npm's similarity policy against the existing
  `agent-pulse-mcp`). The previously-split standalone repo
  `jstuart0/agentpulse-mcp` is retired; all future changes, releases, and
  issues go through this repo.
- **Hook-delivery dedup is now durable identity, not content comparison
  (AGEN-16)** — every stored event carries a server-derived `dedup_key`,
  and a database-level unique constraint on `(session_id, dedup_key)`
  prevents a retried delivery from being stored twice, surviving process
  restarts. Hook deliveries are keyed by the tool's own identity
  (`tool_use_id`) for tool calls and permission events, or by a hash of the
  whole delivery body otherwise — never by comparing event *content*, which
  is what caused repeated tool calls with the same tool name to collapse
  into one another under the old scheme. Events written by other paths
  (transcript reconciliation, managed-session state, AI proposals) keep the
  previous window-based dedup and are unaffected. See "Upgrade notes" below
  for the migration this requires.
- **Hook request bodies over the size cap are dropped, not stored in full
  (AGEN-16)** — `POST /api/v1/hooks` and `/api/v1/hooks/status` still always
  return `200` (never a `4xx`/`5xx`, so a relay never treats an oversize
  delivery as a hard failure), but an oversize body itself is discarded
  before it's parsed. When enough of a `/hooks` delivery's identity
  (session id, hook event name, and related fields) can still be recovered
  from the truncated start of the body, a placeholder row is stored instead
  ("Payload exceeded 16 MiB and was dropped") so the delivery isn't
  invisible; when it can't, nothing is stored for that delivery. Every
  dropped delivery is counted in `oversizeDropped` on `/health` either way.
- **Reserved payload prefix (AGEN-16)** — any top-level key in a hook payload
  whose name starts with `agentpulse_` (case-insensitive) is stripped before
  the payload is processed. That prefix is reserved for server-internal
  bookkeeping (e.g. the oversize placeholder marker above) and is never
  read from client-supplied input.
- **Session-scoped event reads are now ordered by row id (AGEN-16)**, not by
  creation timestamp, removing ordering ambiguity between events created in
  the same instant.
- **AI heuristics (the session-health classifier) now see every tool event
  for a session (AGEN-16)**, not just the ones that survived the old
  content-window collapse.
- **Observer-only Codex sessions show one row per completed turn (AGEN-16)**
  — a session covered only by the Codex observer (no native Codex hooks)
  now shows one "turn completed" row per model turn, matching Codex's own
  turn-completion event, instead of one row per assistant-message chunk.
  Intermediate per-chunk commentary isn't currently surfaced for
  observer-only sessions.
- **Upgrade Codex-observer-carrying supervisors together with the server
  (AGEN-16)** — an out-of-date supervisor posts hook deliveries the server
  now classifies as "legacy" (counted in `legacyObserverDeliveries`) and
  keeps on the previous window-based dedup behavior rather than the durable
  identity above, until the supervisor is upgraded.
- **`rawPayload` shape for hook tool and permission rows (AGEN-16)** — the
  raw `tool_response` copy on `PostToolUse`/`PostToolUseFailure` rows is now
  capped at 4,096 characters (with `tool_response_truncated`/
  `tool_response_chars` flags when cut), independently of the tighter
  2,000-char DB column. `tool_input` is no longer duplicated into
  `rawPayload` for hook tool/permission rows — it was already stored in the
  `toolInput` column — and is replaced with a `tool_input_in_column: true`
  marker. See `docs/MCP.md` for the consumer-facing note.
- **Event storage growth (AGEN-16)** — keeping every distinct tool call
  (rather than silently dropping most of them under the old dedup) grows
  event storage substantially. See "Upgrade notes" below for the measured
  figures and volume-sizing guidance.
- **ask-qa reads only the newest 2,000 events per session (AGEN-16)**,
  previously unbounded, to bound its context size.

### Fixed

- **Supervisor agent routes reachable with a supervisor credential only
  (AGEN-17)** — a mount-order bug put the machine-agent router
  (`/api/v1/supervisors/*`) inside the operator route bundle, after four
  routers whose wildcard `requireAuth()`/`requireOperatorScope()` middleware
  Hono merges across the whole parent router. Every agent-route call
  (`register`, `heartbeat`, `launches/claim`, `managed-session-state`,
  `provider-sync`, `control-actions/*`) was answered by the operator gate
  instead of the handler, needing a `manage`-scoped API key a remote
  supervisor process never carries — so any supervisor whose
  `supervisor.json` predates the AGEN-9 API-key-scope backfill crash-loops
  on every restart. The agent router is now root-mounted, ahead of the
  operator bundle, at both `/api/v1` and `/app-api/v1`; every agent handler
  still carries its own supervisor-credential (or, for `register`,
  enrollment-token) auth, and operator routes are unaffected. No client
  update is required — see the upgrade notes below.

- **Repeated tool calls with the same tool name were silently collapsed
  (AGEN-16)** — hook deliveries were deduplicated by comparing recent event
  *content* against a short rolling window, so e.g. 20 identical `Bash`
  calls in a session could be stored as 2 rows. Every hook delivery is now
  deduplicated by durable identity instead (see "Changed" above), so
  distinct tool calls, turns, and permission events are all stored.
- **Event-authority comparisons used the server process's local time zone
  instead of UTC (AGEN-16)** — under a non-UTC `TZ`, a cross-source
  comparison deciding which of two copies of the same event to keep (e.g. a
  transcript-sourced assistant message superseding a hook-sourced one)
  could misfire. These comparisons are now always UTC, regardless of the
  server's local `TZ`.
- **The live WebSocket feed could show a placeholder id for a newly-stored
  event, then a different id once the client polled (AGEN-16)** — causing
  the same event to render twice in the session timeline. The WebSocket
  broadcast now sends the row actually stored, with its real database id.
- **The AI digest's first day of a session's activity was silently excluded
  from the digest window (AGEN-16)**, due to a bare-timestamp parsing bug;
  it's now included.
- **SQLite full-text-search deletes were a full scan of the search index per
  deleted event (AGEN-16)** — deleting a session with tens of thousands of
  events could take minutes and risked a liveness-probe restart mid-delete.
  Search-index deletes are now keyed by row id, making session deletion
  proportional to the number of rows actually removed.
- **The SQLite search index was rebuilt on every server boot (AGEN-16)**,
  rather than only when it was actually behind; a database that's already
  caught up no longer pays that cost at startup.
- **Postgres search results had no stable tiebreaker (AGEN-16)** — two
  events with an identical timestamp could appear in a different order
  across otherwise-identical requests, including across pages. Postgres
  search now breaks ties by event id.
- **The AI watcher's transcript reader failed to parse Postgres-formatted
  timestamps (AGEN-16)**, silently dropping every event from the watcher's
  context on a Postgres-backed install. Fixed by routing through the shared
  timestamp parser used elsewhere.

- **`GET /sessions`, `/templates`, and `/search` returned zero results for
  an unrecognized `agent_type`/`agentType` filter instead of rejecting it
  (AGEN-44)** — an unknown value (e.g. a newer client's agent type this
  server doesn't know about) now 400s with
  `{ error: "invalid_agent_type", value, allowed }` naming the rejected
  value and the recognized list, instead of silently matching zero rows.
  Absent/empty `agent_type` is unchanged (no filter). The MCP server's
  error mapping surfaces this 400 with the same detail in the tool error
  text. `/sessions` and `/search` validate against the full observed
  `AGENT_TYPES` (including `copilot_cli`); `/templates` validates against
  the narrower launchable-only set, since a template can never target
  `copilot_cli` (see "Added" above).
- **Codex CLI hooks stopped firing on Codex >= 0.145** — the previous
  installer wrote `"type": "http"` hooks, a shape Codex 0.145 no longer
  supports; sessions from an up-to-date Codex silently stopped appearing.
  Fixed by moving to `command`-type hooks (see "Changed" above).
- **Session-name sync silently 403ing since the AGEN-9 API-key-scope
  backfill** — `PUT /native-name` required a `manage`-scoped key, which an
  ingest-only relay/statusline key never carries, so Claude/Codex name sync
  failed silently from a relay install. Fixed by accepting `ingest`-scoped
  keys on this one route (see "Changed" above).
- **The relay dropped hooks outright on a `401`/`403` response** from the
  server instead of retrying — a revoked/rotated key, or a brief
  auth-related server hiccup, would permanently lose the queued hook
  instead of holding it for the next successful auth. `401`/`403` (along
  with `408`/`429`/`5xx`) now retry like other transient failures; only a
  genuine `4xx` rejection (e.g. malformed payload) drops.
- **`byAgentType` on `GET /sessions/stats` omitted agent types with zero
  sessions** instead of reporting `0`, so a dashboard chart iterating the
  full agent-type list could read `undefined` for one it hadn't seen yet.
  Now zero-filled for every known agent type before the real counts are
  applied.
- **The launch recommender could suggest an observe-only agent type**
  (e.g. `copilot_cli`) as the recommended agent for a new launch, which
  can't actually be launched. Recommendations are now filtered to
  launchable agent types only.
- **Host-header injection in served installers** — `/setup.sh`,
  `/setup-relay.sh`, and `/install-local.*` previously could reflect an
  attacker-controlled `Host` header's hostname into the generated hook
  base URL or relay target. Both now use only the numeric port from `Host`
  for same-machine installs and take the server address solely from
  `PUBLIC_URL` for everyone else (see "Changed" above).
- **`GET /api/v1/search` 500'd on Postgres for any session-kind query** —
  the session-search query ordered by a `created_at` column that exists on
  `events` but not on `sessions` (which has `started_at`/
  `last_activity_at`). Fixed to order by `started_at`; pre-existing on
  Postgres installs, unrelated to this release's other Postgres changes.

### Security

- **Supervisors can only act on sessions they own (AGEN-15)** — before this
  fix, any enrolled supervisor could post `managed-session-state` or events
  for *any* session id (including fabricating a brand-new one, or promoting
  a hook-observed session it never launched), silently rebinding it and then
  receiving that session's future prompts — including injected environment
  variables (`launch.env`). Every supervisor write now resolves an owner of
  record (the launch claimant, else the session's managed row, launch
  status ignored) and rejects a non-owner with a uniform
  `403 { "error": "session_not_owned" }`. Claim routing, provider-sync
  listing, stale control-lock expiry, and the lifecycle/AI-classifier
  "is this session's supervisor connected" reads all resolve the same
  owner of record, so a legacy hijacked row self-heals with no migration
  the moment its rightful owner's launch is claimed. Correlation can no
  longer be overridden by a supervisor-supplied id that doesn't match the
  launch it's claiming.
- A `401` from a revoked or rotated supervisor credential during an
  in-session report (`codex-managed.ts`, `claude-headless.ts`) is now fatal:
  the supervisor logs the rejection, terminates every child process it's
  holding for that provider, and exits — instead of silently continuing to
  run with a dead credential. See `deploy/k8s/FORWARDAUTH.md`'s "Supervisor
  client behavior on a rejected in-session report" for the full behavior
  matrix (which calls are fatal-on-401 versus log-and-retry, and why).
- **Prompt and retry now resolve the same launch (AGEN-15)** — a managed
  session whose recorded `launchRequestId` is the legacy fallback shape
  (equal to its own session id, written when a report omitted a real launch
  id) previously left `retryLaunchForSession` unable to find that session's
  actual launch, while `queuePromptAction` already had this fixed. Both
  paths now resolve the real launch by correlation, and both apply the same
  cross-host guard: a managed row whose `launchRequestId` points at a launch
  correlated to a *different* session is rejected rather than acted on.
- The supervisor now bounds and sanitizes the server's response body and
  status text before logging either on a failed request — an oversized
  body, a forged log line, or a terminal escape sequence in a malicious or
  compromised server's response can no longer be written verbatim into the
  supervisor's local log.

- **Symlink-safe Codex/Copilot hooks.json writes** — every installer
  that writes `~/.codex/hooks.json` or `~/.copilot/hooks/agentpulse.json`
  (and their timestamped backups) — `scripts/setup-hooks.sh`,
  `scripts/setup-relay.sh`, the `/setup.sh` endpoint, `bin/cli.ts`, and
  `scripts/install-local.ps1` — now refuses a symlink (or, on Windows, any
  reparse point) at the destination or its parent directory instead of
  writing through it, matching the hook-auth-header file's existing
  guarantee.
- **`install-local.ps1` reparse-point guard on the API key file** —
  `New-ApHookAuthHeaderFile` and the `.agentpulse` directory it writes into
  are now checked for a reparse point before every write, closing the one
  write path on Windows that had no symlink/junction guard at all.
- **`AGENTPULSE_KEY` env var for the direct-install curl\|bash scripts** —
  `--key` is briefly visible in `ps` during a one-time install;
  `scripts/setup-hooks.sh` and the `/setup.sh` endpoint now also accept
  `AGENTPULSE_KEY=ap_xxx curl ... \| bash`, keeping the key out of the
  process list. (`scripts/setup-relay.sh` already supported this.)
- **`provider_event_name` is capped and control-character-stripped**
  — the Copilot canonicalizer's `provider_event_name` (sourced from the
  request body, the `?event=` hint, or `hook_event_name` — all
  attacker-influenced) is now bounded to 128 characters with control
  characters stripped, regardless of source. Audited whether it reaches an
  LLM prompt anywhere in `src/server/services/ai`/`ask`: it doesn't —
  both build their event summaries from the canonical `eventType`, not
  `providerEventType` — so this is defense-in-depth, not a fix for an
  existing prompt-injection path.

### Deprecated

- The following aliases were scheduled for removal in this release. They
  remain supported in 0.6.0 and **will be removed in v0.7.0**. Migrate now:
  - `AGENTPULSE_AUTHENTIK_TRUST_SECRET` env var → use `FORWARDAUTH_TRUST_SECRET`.
  - `agentpulse-strip-client-authentik` Traefik middleware → use
    `agentpulse-strip-client-forwardauth`.
  - `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` → see `deploy/k8s/FORWARDAUTH.md`.
  - The `"authentik"` auth-source value → `"forwardauth"`.

### Upgrade notes

#### AGEN-17 / AGEN-15

If any of your supervisors have been crash-looping since the AGEN-9
API-key-scope backfill, do this before and right after deploying:

**Registration now retries forever with backoff instead of exiting** (also fixed in
this release): once you upgrade the server, a supervisor that's still
running (even mid-retry) reconnects on its own — you don't need to manually restart
it. The per-OS restart notes below (3, 4) are for a supervisor whose *process* actually
stopped (e.g. Windows' scheduled task, or a systemd unit that hit its restart-limit
before this fix shipped), not for one that's simply still retrying.

1. **Inventory and cancel stale `validated` launches** before deploying —
   one could dispatch to the first supervisor that claims it after
   recovery. The population is normally small (a launch left unclaimed when
   the outage began, or a dashboard retry). See the stale-launch query in
   `deploy/k8s/FORWARDAUTH.md`.
2. **Revoke any stopgap `manage`-scoped API key** you put in a supervisor's
   `supervisor.json` as a workaround. That file is world-readable (`0644`)
   by default, so treat a `manage` key placed there as compromised the
   moment it's written — revoke it promptly rather than "eventually" once
   the supervisor is back to using its own credential.
3. **Windows**: the scheduled task only triggers `-AtLogOn` and doesn't
   auto-restart on failure — run `Start-ScheduledTask AgentPulseSupervisor`
   or log back in.
4. **Linux**: if `systemctl --user status agentpulse-supervisor` shows
   `start-limit-hit`, run `systemctl --user reset-failed` before restarting.
5. **A revoked or rotated credential needs `/admin/supervisors/:id/rotate`**,
   never a fresh enrollment — rotate keeps the supervisor's id, and
   therefore every session it already owns. A brand-new enrollment mints a
   new id that owns none of the host's prior sessions.
6. **Optional**: run the ownership audit
   (`deploy/k8s/FORWARDAUTH.md`) to find any session rows left with a stale
   recorded owner from before this fix.
7. **Archive** `~/.agentpulse/logs/supervisor.err.log` if it grew large
   during the outage — the upgrade doesn't truncate it.

#### AGEN-16

- **Database migration (AGEN-16)**: this release adds a `dedup_key` column
  and two indexes to the `events` table. **Back up your SQLite database
  before upgrading** (see `deploy/k8s/BACKUP-RESTORE.md`). On Postgres,
  building the indexes takes a `SHARE` lock on `events` — see
  `deploy/k8s/README.md` → "Upgrading to migration 0003" for the
  out-of-band index-build procedure and the required `pg_index.indisvalid`
  verification step; run it in a maintenance window on a large table.
- **Storage growth (AGEN-16)**: on a 30-day replay of a real workload, event
  storage after the growth mitigations above grew roughly 840 MB / 30 days
  on SQLite (about 28 MB/day on average, up to ~137 MB/day at peak). A 1Gi
  volume on a storage class that enforces the PVC's size request fills in
  roughly 37 days at that rate; `local-path` volumes are bound by node disk
  instead and aren't affected the same way. Size the volume accordingly —
  see `deploy/k8s/README.md` → "Data volume sizing". Retention enforcement
  isn't implemented yet and is tracked as a follow-up.
- **Old (unstamped) relays (AGEN-16)**: a relay that hasn't been upgraded to
  send `X-AgentPulse-Delivery-Id` can store a retried non-tool hook (a
  `Stop` or a prompt) twice if the relay retries a delivery. Tool calls are
  unaffected — they dedupe on their own `tool_use_id` regardless of the
  header. Upgrade the relay to close this window.
- **API keys (AGEN-16)**: use one ingest API key per producer host. Dedup
  identity is scoped per API key, so rotating a key defeats deduplication
  for any retry that straddles the rotation — a rare, fail-open case that
  produces an extra stored copy, never a lost event.

#### AGEN-13

- **Database migration**: this release adds one index,
  `idx_sessions_agent_type_last_activity`, on
  `sessions (agent_type, last_activity_at)`. It's idempotent
  (`IF NOT EXISTS`) on both SQLite and Postgres. On Postgres, building it
  takes a `SHARE` lock on `sessions` for the build's duration — milliseconds
  on a small-to-moderate table, safe to run inline at boot. On a large
  table, pre-create it out-of-band before rolling out — see
  `deploy/k8s/README.md` → "Upgrading to migration 0004" for the exact
  `CONCURRENTLY` command and the `pg_index.indisvalid` verification step.
- **Re-run every installer after upgrading** — `setup-hooks.sh`,
  `setup-relay.sh`, and `/setup.sh`. Codex's hooks are rewritten in the new
  `command` shape (your old `hooks.json` is backed up first), and you'll
  need to run `/hooks` inside Codex once afterward to trust them; a
  relay's key needs Observe in addition to Hook ingest, or pass
  `--allow-missing-observe`; and an existing plaintext key export in your
  shell rc file is left in place with a removal warning, not edited
  automatically — see "Changed" above for the exact new layout.
- **`PUBLIC_URL` is now load-bearing for `/setup-relay.sh`.** Without it
  (or with a `localhost` value), the served relay installer 503s for
  anyone not on the server's own machine. The Kubernetes manifests already
  set it (`deploy/k8s/02-configmap.yaml`); other deployments should confirm
  it's set to a URL your remote machines can actually reach.

## [0.5.0] — 2026-07-17

Client-currency release: brings AgentPulse fully current with Claude Code
2.1.212 and Codex CLI 0.144.5 (audit F1–F9), adds permission-wait visibility,
Claude native session-name sync, per-host client versions, and a permanent
hook-event parity guard.

### Added

- **Claude Code hook refresh (F4)** — six new hook events registered across
  every wiring site: `PermissionRequest`, `PermissionDenied`, `Notification`,
  `PreCompact`, `PostCompact`, `PostToolUseFailure` (10 → 16 total events).
  Permission events land under a new `permission_event` category, distinct
  from the silent `system_event` else-branch; compaction and notification
  events stay `system_event`. A session blocked on a permission prompt now
  visibly flips to the existing `"waiting"` semantic status and reverts once
  resolved (state tracked in `sessions.metadata.permissionWait`, correlated
  by `tool_use_id` with an anonymous-count fallback — see Decision 10 in the
  client-currency remediation plan for the full concurrency model). Unknown
  hook event names now log once per distinct name instead of silently
  dropping content. New architecture guard `check:hook-event-parity`
  (wired into `check:architecture`) fails CI if any of the seven Claude/Codex
  wiring-site event lists drift from the `src/shared/types.ts` unions.

- **Codex CLI hook refresh (F3)** — five new hook events registered across
  every Codex wiring site: `SubagentStart`, `SubagentStop`, `PermissionRequest`,
  `PreCompact`, `PostCompact` (5 → 10 total events, confirmed against the
  official hooks docs and empirically against codex-cli 0.144.5's
  `codex features list`/`codex doctor` output — the audit's earlier "9 total"
  claim was off by one). All five reuse normalizer branches already built in
  the Claude Code hook refresh (F4) — `SubagentStart`/`SubagentStop` land as
  `progress_update`, `PermissionRequest` as `permission_event`,
  `PreCompact`/`PostCompact` as `system_event` — no normalizer changes were
  needed. Live-verified on 0.144.5: `codex doctor` reports
  `[features] codex_hooks = true` as a recognized **legacy alias for
  `hooks`**, which is `stable`/enabled by default with zero config — the flag
  is no longer required but remains harmless, so setup scripts keep writing
  it for compatibility with older codex-cli installs. All Pattern-C
  edit-point comments/prose updated to say so. The stale
  `src/supervisor/index.ts` observer comment ("sessions appear even when
  Codex's own HTTP hooks don't fire") is corrected: hooks are the primary
  source since 0.124.0, the observer stays as belt-and-suspenders + backfill.

- **Snippet status-enum parity (F6)** — `snippets/agents-md-snippet.md`'s
  reported-status enum now matches `snippets/claude-md-snippet.md` and the
  server's canonical `SEMANTIC_STATUSES`: `researching|implementing|testing|
  debugging|reviewing|documenting|planning|waiting`. The Codex snippet was
  missing `reviewing`, `documenting`, and `waiting`. Docs-only — no code
  reads the enum outside `src/shared/constants.ts` and `StatusBadge.tsx`.

- **Claude native session-name pull sync (F5)** — `scripts/statusline.sh`
  now reads Claude Code's native `session_name` from the statusline JSON and
  pushes it into AgentPulse's `displayName` via a new
  `PUT /api/v1/sessions/:id/native-name` route, fire-and-forget with a 1s
  timeout and full output redirection so it can never corrupt or slow the
  rendered statusline. Pull-only in this release — there's no supported way
  to write a name back into Claude Code's own session store. A manual
  dashboard rename always wins: renaming a session sets
  `metadata.renameSource = "user"`, and the native-name route refuses to
  overwrite a session carrying that flag. The route 404s on an unknown
  session (a deliberate departure from `/rename`'s silent no-op) so the
  statusline caller can distinguish "not yet ingested — retry next render."
  Already-installed statuslines are a manually-copied file and need
  re-copying to pick up the sync — see the new Statusline section in
  README.md.

- **Client binary version awareness (F7)** — the supervisor now captures
  each configured Claude/Codex executable's reported version
  (`<exe> --version`, ~2s timeout) at registration and exposes it as
  `capabilities.executables.{claude,codex}.binaryVersion` alongside the
  existing `resolvedPath`. HostsPage renders it next to the resolved path
  ("claude 2.1.212 — /path", falling back to "version unknown"). Field is
  additive and optional — older supervisors registering without it remain
  valid. Also: `providerProtocolVersion` capture for managed Codex launches
  now warns once per distinct value when the app-server's `initialize`
  response omits or malforms `protocolVersion`, instead of silently
  coercing to `"app-server"`.

### Changed

- **Codex CLI upgraded 0.142.5 → 0.144.5.** Installed via the global npm
  package `@openai/codex`, not Homebrew — the CLI is not brew-managed on
  this install path, correcting an earlier assumption. Post-upgrade smoke
  checks: `codex --version` reports `0.144.5`; the rollout-file observer's
  session directory layout (`~/.codex/sessions/YYYY/MM/DD/`) is unchanged
  and today's rollout files still start with a valid `session_meta` JSON
  record; `codex app-server --help` still exposes the app-server subcommand
  and `--listen` flag (exit 0); `~/.codex/config.toml`'s
  `[features] codex_hooks = true` block is untouched by the upgrade.

### Removed

- **Dead `turn_id` payload-shape agent-detection fallback (F8)** —
  `detectAgentType` no longer falls back to inspecting `payload.turn_id`;
  every Codex producer (observer, setup-generated hooks, relay) has always
  sent the `X-Agent-Type: codex_cli` header, so the fallback never fired.
  Detection is now header-only, defaulting to `claude_code` when the header
  is absent or unrecognized. The now-unused `turn_id?` field is removed
  from `HookEventPayload` and the observer's local `HookPayload` type.

This closes out the client-currency remediation campaign (F1–F9): Codex CLI
upgraded to 0.144.5, pricing table covers Claude 5 / gpt-5 / o-series models
with a safer fallback rate, Claude and Codex hook-event lists are current
(16 and 10 events respectively) with a permission-wait dashboard signal and
a drift guard protecting parity going forward, snippet status enums match,
Claude's native session name pulls into the dashboard, client binary
versions surface on HostsPage, and the Postgres CI job is green.

## [0.4.0-pre.2] — 2026-05-05

### Added

- **Generic forwardauth abstraction** — AgentPulse SSO now works with any
  forwardauth-capable identity provider, not just Authentik. Configure the provider
  via `FORWARDAUTH_PROVIDER` (label, defaults to `"authentik"`) and
  `FORWARDAUTH_HEADER_*` env vars (header names, default to Authentik values).
  Existing Authentik operators upgrade with zero migration burden — defaults preserve
  current behaviour.

- **`FORWARDAUTH_TRUST_SECRET` env var** — new canonical name for the shared-secret
  trust gate. The deprecated alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` continues to
  work for one release (boot-time deprecation warning emitted when only the legacy
  name is set). Both env vars are bound to the same Kubernetes Secret field
  (`FORWARDAUTH_TRUST_SECRET` in `01-secret-template.yaml`) so operators rotate in
  one place.

- **`provider` field in `/auth/me`** — the response now includes `provider: string | null`
  alongside the existing `source` field. For forwardauth sessions, `provider` reflects
  the configured `FORWARDAUTH_PROVIDER` value (e.g. `"authentik"`, `"authelia"`).
  The dashboard UI reads `provider` to label the user menu (falls back to `"SSO"`).

- **`agentpulse-strip-client-forwardauth` Traefik middleware** — generic name for the
  header-strip middleware (previously `agentpulse-strip-client-authentik`). The IngressRoute
  now references the new name. The legacy `agentpulse-strip-client-authentik` resource
  is kept as a duplicate for one release so existing overlays referencing the old name
  continue to work.

- **`deploy/k8s/FORWARDAUTH.md`** — restructured setup guide covering Authentik,
  Authelia, oauth2-proxy, Pomerium, and Cloudflare Access with provider-specific
  `FORWARDAUTH_HEADER_*` values for each. Old `AUTHENTIK-FORWARDAUTH.md` is now a
  one-line redirect stub (retained for one release to avoid breaking external links).

- **`scripts/check-no-authentik-literals.ts` architecture guard** — fails CI when a
  new `X-Authentik-` header literal appears in `src/` outside the explicitly allowlisted
  files (`src/server/config.ts` and `src/server/auth/middleware.ts`). Wired into
  `bun run check:architecture`.

### Deprecated

- `AGENTPULSE_AUTHENTIK_TRUST_SECRET` env var — use `FORWARDAUTH_TRUST_SECRET`.
  Accepted for one release with a boot-time warning. Removed next release.

- `agentpulse-strip-client-authentik` Traefik Middleware resource — renamed to
  `agentpulse-strip-client-authentik`; the legacy resource is kept as a duplicate for
  one release. Removed next release.

- `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` — renamed to `deploy/k8s/FORWARDAUTH.md`.
  The stub redirect at the old path is retained for one release. Removed next release.

---

## [0.4.0-pre.1] — 2026-05-05

Post-release fixes surfaced during the live rollout of `v0.4.0` to the thor homelab cluster.
The core postgres-backend campaign shipped clean against the test suite; these four issues only
appeared during actual Kubernetes deployment against a real Authentik/Traefik stack. Operators
upgrading from any pre-postgres version should apply this patch before deploying v0.4.0 in production.

### Fixed

- **`.dockerignore` exception for `deploy/k8s/scripts/`** — the `deploy/` exclusion in `.dockerignore`
  prevented `scripts/build-and-push.sh` from building the `agentpulse-backup` image because
  `Dockerfile.backup` needs `run-backup.sh` and `retention.sh` from that directory. Added
  `!deploy/k8s/scripts/` exception so both Dockerfiles build correctly from the same context.
  (`a88d289`)

- **backup-sidecar `cpu` request raised from `10m` to `50m`** — the request fell below the
  `08-limitrange.yaml` floor of `50m` (added in the same campaign as the sidecar). Pods were
  rejected at admission. The 50m value is a scheduler-accounting floor; the sidecar is idle
  except during the daily 04:15 UTC backup window. (`a88d289`)

- **`AGENTPULSE_PG_POOL_MAX` secretKeyRef marked `optional: true`** — operators upgrading from
  a pre-postgres install (where the secret key was never created) got `CreateContainerConfigError`
  on every pod start. The app already defaults to 10 when the env var is absent; the optional flag
  lets the kubelet tolerate a missing key without blocking the pod. (`a88d289`)

- **`AGENTPULSE_AUTHENTIK_TRUST_SECRET` wired into base deployment** — the audit-remediation
  campaign (v0.3.0) added the in-process trust gate but never wired the corresponding env var
  binding into `04-deployment.yaml`. Every Authentik-authenticated request fell through to
  local-auth because `verifyAuthentikSecret()` read an empty config value. Wired with
  `optional: true` so SQLite/local-auth-only deployments boot without configuring the secret.
  (`b0f16ea`)

- **`authRouter` mount moved to root app to fix 401 on `/api/v1/auth/me`** — Hono cascades
  `.use("*", requireAuth())` from sibling routers across the entire parent router when merged
  with `api.route()`. With `authRouter` under the api bundle, every `/api/v1/auth/*` request
  hit `requireAuth()` before reaching the handlers — turning the intentionally-unauthenticated
  `/auth/me` into a 401, which broke the login page. Moved to `app.route("/api/v1", authRouter)`
  mirroring the existing `cspReportRouter` and `telegramWebhookRouter` pattern. (`403a4d5`)

- **OIDC trust gate completed end-to-end** — the v0.3.0 trust-gate design left header injection
  unimplemented. The base manifest stripped the `X-Authentik-Verify` header on input and listed
  it in `authResponseHeaders`, but nothing actually emitted it, so the gate rejected 100% of
  Authentik-authenticated requests. The working path is a Traefik `headers` middleware
  (`agentpulse-inject-verify`) that injects the shared secret after forwardauth passes — not an
  Authentik property mapping (which populates JWT id_token claims, not forwardauth response
  headers). Added the middleware to `06-middleware.yaml` and wired it as the third step in the
  protected-route chain (strip → forwardauth → inject-verify) in `07-ingressroute.yaml`. (`dc94356`)

- **Public-route bypasses added to IngressRoute** — three path groups were missing from the
  public (no-forwardauth) route entries, causing browsers to receive Authentik 302 redirects for
  content that must be reachable unauthenticated: `/api/v1/ready` (kubelet readiness probe),
  `/assets/*` (Vite JS/CSS chunks — Authentik's 302 response broke Vite's dynamic import with a
  MIME mismatch), and `/api/v1/auth/{me,login,logout,signup}` (login-page bootstrap calls).
  `/api/v1/auth/change-password` remains protected (enforces `requireAuth()` in-handler). (`dc94356`)

## [0.4.0] — 2026-05-05

This release adds a complete PostgreSQL backend at parity with the existing SQLite path.
Operators can now run AgentPulse against a managed Postgres instance for multi-replica
deployments. SQLite remains the default for OSS quickstart and single-machine use.

Plane ticket: [AGEN-3](https://plane.xmojo.net/agile-solutions-group/projects/7ec41b9d-5efa-4f56-bc82-930f76b01345/).
Branch: `feat/postgres-backend` — 13 commits, 147 files changed.

### Added

- **PostgreSQL backend** — set `DATABASE_URL=postgres://...` at boot; AgentPulse resolves
  the dialect once at startup (`config.dialect`, memoized) and opens a postgres-js
  connection pool. All API endpoints behave identically on both backends.
- **Drizzle-kit migration runner** — fresh SQLite installs and all Postgres installs now
  use Drizzle migrate instead of the legacy `initializeDatabase()` DDL block. Generated
  baselines committed at `drizzle/sqlite/0000_*.sql` and `drizzle/postgres/0000_*.sql`
  (29 tables, 7 cascade FKs, composite PK on `ai_daily_spend`, 6 partial-WHERE unique
  indexes on Postgres).
- **Dual-dialect schema split** — `src/server/db/schema/{core,ai,ask-projects}/` with
  per-table files and a column-factory pattern. Per-dialect entry files (`schema/sqlite.ts`,
  `schema/postgres.ts`). Runtime barrel (`schema/index.ts`) re-exports the SQLite set for
  existing callers (12 importers still on legacy path — follow-up).
- **`withTransaction()` helper** — dialect-aware transaction wrapper. Includes a runtime
  guard that throws on async-callback misuse (bun-sqlite Drizzle silently disables rollback
  on async callbacks — the guard prevents this class of bug going forward).
- **`PostgresSearchBackend`** — implements the `SearchBackend` interface with ILIKE-based
  full-text search. `SearchResult.backend` is now `"fts5"` (SQLite) or `"postgres-ilike"`
  (Postgres). The `"postgres-tsvector"` value is reserved for a follow-up campaign.
- **SQL helpers** (`src/server/db/sql-helpers.ts`) — `nowSql`, `intervalSecondsSql`,
  `jsonExtractText`, `likeStartsWith`, `likeContains`, `executeRows`; dialect-aware,
  with rendered-SQL assertions in tests.
- **GHA two-job CI** — `test-sqlite` runs on every push; `test-postgres` runs on push to
  `main`/`dev` with a `postgres:16-alpine` service container and healthcheck.
- **`deploy/overlays/postgres/`** — Kustomize overlay that removes the SQLite backup
  sidecar, switches to `RollingUpdate`, and wires `DATABASE_URL` from a Postgres connection
  string. Pre-flight checklist and README at `deploy/overlays/postgres/README.md`.
- **`AGENTPULSE_PG_POOL_MAX`** env var — integer [1, 100], defaults to 10. Invalid values
  log a warning and fall back to 10.
- **`AGENTPULSE_LEGACY_INIT`** env var — set to `"false"` to force Drizzle migrate on an
  existing SQLite install (opt-in; unset preserves legacy path for existing installs).
- **`isUniqueViolationError` helper** — narrow-catches Postgres SQLSTATE `23505` and
  SQLite `SQLITE_CONSTRAINT_UNIQUE` for portable duplicate-detection in service code.
- **Advisory lock boot serialization** — Postgres installs acquire a session-level
  `pg_advisory_lock(2850603287)` on the migration client connection before running
  migrations. Safe for rolling deploys with multiple replicas booting simultaneously.
- **Architecture guards** — `scripts/check-no-bun-sqlite-only-apis.ts` (prevents
  bun-SQLite-only APIs in dialect-shared paths) and `scripts/check-no-legacy-schema-import.ts`
  (flags direct imports of the deprecated `schema.ts` shim).
- **Test harness** — `test-utils/backend.ts` exports `describeSqliteOnly`, `describePostgresOnly`,
  `itSqliteOnly`, `itPostgresOnly` for gating dialect-specific tests. 9 existing test files
  reclassified as SQLite-only.
- **7 follow-up plan stubs** in `thoughts/postgres-followup-plans/`: pgvector embeddings,
  jsonb raw_payload, LISTEN/NOTIFY transcript sync, tsvector search, FOR UPDATE SKIP LOCKED
  leaser, deterministic Postgres search rank, and legacy-init removal.

### Changed

- **`DATABASE_URL` base manifest default changed from a non-functional Postgres placeholder
  to `""`** — existing installations applying the base manifests now get SQLite by default
  rather than failing on the old placeholder URL. Operators who want Postgres apply the
  `deploy/overlays/postgres/` overlay.
- **`config.dialect`** replaces the deprecated `useSqlite` export in `src/server/db/dialect.ts`.
  The old export is retained as a deprecated alias for one release.
- **`src/server/db/__test_db.ts`** moved to `src/server/db/` (canonical location). A
  re-export shim at the old path remains for one release.
- **`initializeDatabase()` is now async** — any caller that was not `await`ing it would
  have a bug; verified clean across all callers.
- **`bun run db:migrate`**, **`db:push`**, **`db:studio`** (bare) removed — use the
  per-dialect variants (`db:migrate:sqlite`, `db:migrate:postgres`, etc.).

### Limitations (documented deferrals)

- **Vector search is SQLite-only.** `event_embeddings` and the embedding + vector-enricher
  services are gated on `config.dialect === "sqlite"`. The pgvector port is a follow-up
  campaign (`thoughts/postgres-followup-plans/pgvector-event-embeddings.md`).
- **Postgres search uses ILIKE, not tsvector.** Adequate for moderate event volumes.
  A tsvector migration for high-volume deployments is a follow-up
  (`thoughts/postgres-followup-plans/tsvector-search-perf.md`).
- **No SQLite→Postgres data migrator.** Postgres installs start fresh. Migrating existing
  data requires a manual `pg_dump` / COPY or a custom migration script.
- **12 settings importers still on legacy schema barrel** — tracked via `TODO(Phase 2b)` in
  `schema/index.ts`; will be addressed alongside `sqlite-legacy-init-removal.md`.
- **`Postgres json` (not `jsonb`)** — JSON columns match the SQLite `text({mode:'json'})`
  runtime contract. GIN indexes on payload fields are a follow-up (`jsonb-raw-payload.md`).

## [0.3.0] — 2026-05-05

This release is the audit-remediation campaign (P1–P15). The primary goal was
hardening the public-facing security posture before broader OSS distribution.
All breaking changes are listed first; other changes follow.

### Breaking changes

- ⚠ breaking — **`HOST` default changed from `0.0.0.0` to `127.0.0.1`.**
  Running `bun run start` (bare, without Docker) now binds to localhost only.
  To restore the previous behaviour, set `HOST=0.0.0.0` in your environment.
  The `Dockerfile` already sets `ENV HOST=0.0.0.0` so container deployments
  are unaffected.

- ⚠ breaking — **`AGENTPULSE_ALLOW_SIGNUP` default changed from `true` to `false`.**
  The first-run signup flow is now opt-in. Set `AGENTPULSE_ALLOW_SIGNUP=true`
  to allow open signup on an empty instance. Existing installs with users already
  created are unaffected — signup was already blocked once any user existed.
  The flag `auth.firstRunCompleted` is written atomically in the same SQLite
  transaction as the user row; two concurrent signup requests on an empty instance
  now guarantee exactly one succeeds.

- ⚠ breaking — **Settings allowlist (replaces prefix denylist).** `PUT /api/v1/settings`
  now rejects any key not explicitly listed as user-settable, returning
  `{ "error": "key_not_user_settable", "key": "..." }` with HTTP 403. Previously
  the endpoint blocked only `ai.*` / `vectorSearch.*` / `telegram:credentials`
  prefixes; all other keys were accepted. Service-internal callers already
  pass `{ allowProtected: true }` and are unaffected.

- ⚠ breaking — **Authentik trust secret required for SSO deployments.**
  Set `AGENTPULSE_AUTHENTIK_TRUST_SECRET` to the shared secret configured in
  Authentik's property mapping for the agentpulse proxy provider. AgentPulse
  verifies the `X-Authentik-Verify` header on every SSO request using
  `crypto.timingSafeEqual` with a length guard. Missing or mismatched secret
  strips all Authentik identity headers and treats the request as unauthenticated.
  Rotation procedure: regenerate the secret → update Authentik property mapping
  value + AgentPulse k8s Secret → restart agentpulse pod. Traefik holds no secret
  and is unchanged across rotations. See `deploy/k8s/AUTHENTIK-FORWARDAUTH.md`
  and `deploy/k8s/RUNBOOK-secrets-rotation.md`.

- ⚠ breaking — **`source` string changed for 4 proposal-decision events.**
  The events `proposal_accepted`, `proposal_declined`, `proposal_auto_applied`,
  and `proposal_expired` now carry `source: "managed_control"` instead of
  `source: "observed_hook"`. Downstream log queries or metrics that key on the
  literal string `"observed_hook"` for these events will silently stop matching.
  Update filters to `"managed_control"`.

- ⚠ breaking — **Hook ingest always-200 contract reaffirmed.**
  Rate-limited hook drops are silent (the agent never sees an error). The drop
  counter is exposed in `GET /api/v1/health` under `ingestCounters`. Any
  monitoring or alerting that expected non-200 responses from `/api/v1/hooks`
  under load needs to switch to polling the health endpoint counter.

- ⚠ breaking — **Graceful drain on SIGTERM (k8s deployments).**
  The pod's `preStop` hook calls `POST /api/v1/internal/drain` (loopback-only)
  which sets `shuttingDown = true` and polls until in-flight event processing
  completes. Readiness goes 503 immediately. `terminationGracePeriodSeconds: 90`
  in the deployment gives 30 s preStop budget + 60 s post-TERM grace. The
  `/api/v1/internal/*` path is excluded from all public IngressRoutes.

- ⚠ breaking — **Image-tag-by-SHA convention; `imagePullPolicy: IfNotPresent`.**
  The k8s deployment manifest pins the image to a specific commit SHA tag
  (e.g. `ghcr.io/jstuart0/agentpulse:<sha>`). Run `./scripts/build-and-push.sh`
  to build and get the printed SHA, then update `deploy/k8s/04-deployment.yaml`
  (or your homelab overlay) before applying. `imagePullPolicy: IfNotPresent`
  is now set explicitly. The prior `:latest` reference is removed.

- ⚠ breaking — **Storage stance: SQLite stays on local-path PVC.**
  Do NOT relocate `agentpulse.db` to an NFS-backed storage class. SQLite WAL
  mode requires shared-memory semantics that break on network filesystems; this
  causes silent corruption. Durability is provided by a nightly in-pod
  `backup-sidecar` container that writes `.backup` snapshots to a separate
  NFS-backed PVC (`agentpulse-backups`). Restore runbook: `deploy/k8s/BACKUP-RESTORE.md`.
  PostgreSQL backend (the long-term answer) is the explicit next epic.

### Changed

- **Docker host-publishing.** All documented `docker run` examples with
  `DISABLE_AUTH=true` now use `-p 127.0.0.1:3000:3000` instead of
  `-p 3000:3000`. The old form published the auth-disabled server on all host
  network interfaces. A startup warning fires when `DISABLE_AUTH=true` and
  `HOST=0.0.0.0` are both active, reminding operators to use the
  `127.0.0.1:` host-binding prefix.

- **CSP-Report-Only header shipped.** Every response now includes a
  `Content-Security-Policy-Report-Only` header. Violations are collected at
  `POST /api/v1/csp-report` as structured JSON. No content is blocked in this
  release. Enforcement mode (`Content-Security-Policy`) will follow once reports
  are clean in production.

- **WebSocket Origin validation strict everywhere.** The WS upgrade handler
  now validates `Origin` against `PUBLIC_URL` in all environments (no
  `NODE_ENV=development` bypass). Vite's dev server proxies WebSocket same-origin
  so development workflows are unaffected.

- **Lazy DB initialization + AI module split.** `src/server/db/client.ts` is
  now lazy-initialized on first use rather than at import time, eliminating the
  startup race between the module-level DB handle and `initializeDatabase()`.
  The AI route module is split into `ai-providers.ts`, `ai-watcher.ts`,
  `ai-inbox.ts`, `ai-intelligence.ts`, `ai-status.ts`, and `ai-gates.ts`
  to reduce cold-start time for non-AI installs.

- **Accessibility — critical fixes.** Every interactive element now has a
  visible focus ring and a descriptive `aria-label`. Keyboard navigation through
  session cards, inbox items, and templates is complete. Color-contrast failures
  resolved across dashboard, inbox, and session detail.

- **Prompt injection nonce.** User-supplied content rendered in the dashboard
  is wrapped in a nonce-validated sanitizer to prevent injected HTML from
  executing in the browser context.

- **`evaluation-report.md` moved** from project root to `thoughts/audits/`
  (`thoughts/` is gitignored in OSS commits). All 22 audit findings from the
  April 2026 code-health audit are closed by this release.

### Added

- `deploy/k8s/BACKUP-RESTORE.md` — restore runbook for the in-pod backup sidecar.
- `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` — Authentik property-mapping setup guide.
- `deploy/k8s/RUNBOOK-secrets-rotation.md` — Authentik trust secret rotation steps.
- `deploy/k8s/` manifests: LimitRange, ResourceQuota, NetworkPolicy, ServiceAccount,
  backup PVC, backup-sidecar container in deployment.
- `GET /api/v1/sessions/:id/claude-md` and `PUT /api/v1/sessions/:id/claude-md`
  endpoints for per-session CLAUDE.md management (replaces the earlier
  `/api/v1/agents-md` proxy, which was a fetch-through to the filesystem).
- `src/supervisor/` — local supervisor process for same-machine launch/control.
- Dev commands: `bun run dev:supervisor`, `bun run test`, `bun run test:watch`,
  `bun run check:fix`, `bun run check:architecture`.

## [0.2.0-pre.10] — 2026-05-01

Reliability hotfix for two stacked production issues that were
surfacing as user-visible "could not connect to the LLM" / "network
error" messages from Ask and Telegram.

### Fixed

- **Cold-load LLM timeouts.** The Ask sync and streaming paths used a
  60s timeout on the LLM call, which is too tight for cold-load on
  local 20B+ models — first-token latency runs 60–90s when a model
  has been evicted from GPU memory. Bumped both timeouts to 180s.
  Classifier timeouts (8s) stay tight on purpose so a slow gate
  fails fast and lets the main turn proceed. When a timeout does
  fire, the user-facing message is now timeout-specific ("LLM
  didn't respond in time — usually a cold model load. Try again in
  a few seconds.") instead of the generic "couldn't reach" copy.
- **Pod restart loop from over-tight liveness probes.** Default
  Kubernetes `timeoutSeconds: 1` was triggering on `/api/v1/health`
  whenever the event loop was briefly busy (LLM streaming, FTS
  backfill). Bumped both probes to `timeoutSeconds: 5` and the
  liveness probe to `failureThreshold: 5`. Validated in production:
  4 restarts in 41h vs. the prior ~18 restarts in 18h.

## [0.2.0-pre.9] — 2026-04-29

Efficiency redesign. Building on the type-discipline work in pre.8, this
release consolidates the largest remaining duplication patterns across
the orchestration core so that adding a new kind, gate, executor, or
classifier is a one-place change instead of a five-place change.

### Changed

- **Inbox card surface unified.** 12 nearly-identical action-request
  card components collapsed into one `ActionRequestCard` driven by a
  per-kind spec table. Adding a new action kind is now one entry in
  one switch, with an exhaustiveness guard. The freeform-alert-rule
  card now has the same KindBadge / severity / busy-state polish as
  every other card.
- **Ask orchestrator unified across transports.** The 9-gate ladder
  previously hand-stamped in both the sync and streaming Ask
  pipelines is now a single `ASK_GATES` table consumed by a shared
  `runAskGates` runner. New gates are one row, automatically wired
  into both transports; previously a new gate had to be inserted in
  two places in matching order.
- **Action-request executors consolidated.** The thirteen executor
  functions (launch / archive / edit / delete / alert-rule / etc.)
  now share `succeed`, `fail`, and `failExpired` helpers that bundle
  the conditional-update + notify + return triple they all do, plus
  a `runExecutor<K>` frame for the simple cases. Each executor's
  unique logic now reads at a glance.
- **Intent classifiers consolidated.** All eight intent detectors
  (launch / resume / session-action / template-CRUD / alert-rule /
  bulk-action / Q&A / add-project) now share a `classifyJson<T>`
  helper for the provider-fetch / spend-check / adapter-call / JSON-
  parse boilerplate. Each detector is now its system prompt plus a
  small parse lambda — the actual differences are immediately
  visible.
- **Ask message-meta unified.** One shared tagged-union parser
  (`parseAskMeta`) replaces three separate server encode/extract
  pairs and three separate frontend parsers; the AskPage chained-`&&`
  detection logic is gone.
- **Inbox kind metadata centralized.** One `KIND_META` table drives
  both the filter dropdown and the footer counters; missing kinds
  fail to compile. Closes a pre-existing bug where the footer was
  missing the `add_channel` counter.

### Fixed

- **Single canonical archive predicate.** `sessions.is_archived` is
  now the only source of truth for whether a session is archived;
  `status='archived'` is retained only for backward compat. A
  shared `isVisibleSession(s)` / `isArchivedSession(s)` helper pair
  replaces a mix of `isArchived = false` and `status !== 'archived'`
  filters scattered across the codebase. Idempotent DB backfill at
  startup converts any historical row with `status='archived'` to
  `is_archived = 1`. The Archive badge still flips immediately on
  archive click. Net effect: digest counts, the operator inbox,
  and Ask candidate resolution no longer leak archived-but-active
  sessions; the transcript-sync worker no longer wastes IO polling
  archived agents.

### Behind the scenes

- 24 files modified, 12 deleted, 3 added; **−1,821 LOC net**
  while tightening rather than loosening invariants.
- 612/612 tests pass; typecheck clean; 0 Biome errors.

## [0.2.0-pre.8] — 2026-04-28

A focused type-duplication remediation cycle. An external PR (#13) tried
to add a Cohere LLM adapter, which exposed that `ProviderKind` was
duplicated across 4 places with no compile-time enforcement: the PR
updated one and the other three would have silently rejected /
not-displayed the new value. A follow-up audit found **22 instances** of
this same anti-pattern. This release closes all 22 across four slices.

### Fixed

#### Comprehensive type-duplication audit (Slices TYPE-2a/b/c/d)

Established a uniform recipe applied across the codebase:

```ts
export const KNOWN_X_KINDS = ["a", "b", "c"] as const;
export type XKind = (typeof KNOWN_X_KINDS)[number];
```

Single source of truth in `src/shared/types.ts`. Server and client
re-export. Runtime allowlists become `KNOWN_X_KINDS.includes(...)`.
Label/color maps tightened from `Record<string, V>` to `Record<XKind,
V>` so missing keys fail to compile. UI dropdowns add `as const
satisfies` exhaustiveness checks.

**TYPE-2a** (10 fixes, 19 files): `ProviderKind`, `AgentType`,
`SessionStatus`, `SemanticStatus`, `ApprovalPolicy`, `SandboxMode`,
`AskMessageRole`, `WatcherPolicy`, `DecisionKind`, `HitlReplyKind`,
`ActionRequestKind` (converted from asserted-array to derived type).
Real bug exposed: `AgentTypeBadge.tsx` was indexing `AGENT_TYPE_LABELS`
with an arbitrary `string` prop — the tightened `Record<AgentType,
string>` rejected the access.

**TYPE-2b** (1 fix, 12 files): **`ManagedState`** — the highest-leverage
finding. Was plain `string` in the schema with 9 distinct values
stamped across 17+ supervisor producer sites; `getSessionMode`
silently returned `"observed"` for any unknown value. Promoted to a
typed union; `getSessionMode` rewritten as `Record<ManagedState,
SessionModeStyle>` so adding a new state to `MANAGED_STATES` requires
a Record entry — compile fails otherwise. Real bug exposed:
`intelligence-service.test.ts:83` was inserting a stale
`managedState: "running"` fixture with no producer; fixed to
`"managed"`.

**TYPE-2c** (3 fixes, 15 files): `AlertRuleType`,
`NotificationChannelKind`, `SessionMutationKind`. The
`action-requests-service.ts` `ruleTypeLabel` switch had a silent
`default:` that echoed the raw kind string into user-facing
notification text — replaced with an exhaustive `never` guard. Two
runtime allowlists (`inbox-service.ts` `validKinds` and
`action-requests-service.ts` channel kinds) collapsed onto the shared
const.

**TYPE-2d** (6 fixes, 33 files): `EventCategory` exhaustive switches
in `TimelineView.tsx` and `ai/context.ts` — the 7 `ai_*` event
categories were silently rendering as "Event" in the UI and being
dropped entirely from classifier context. Now explicit labels ("AI
Proposal", "AI HITL", "AI Continue", "AI Report", etc.) and one-line
context entries. `AskThreadOrigin` (44 inline `"web" | "telegram"`
literals across 14 files), `ActionRequestDecision` (12 inbox cards
+ 2 server compare sites), `WatcherRunTriggerKind`, `InboxKind`
(now `Extract<InboxWorkItem["kind"], …>` so removing one of the
session-scoped kinds cascades to snoozing), `LabsFlag`.

#### Why it matters

After these slices, adding a new value to any of these unions is a
**one-line change** in `src/shared/types.ts`. TypeScript chases every
consumer — runtime allowlist, UI dropdown, color map, switch
statement, executor branch. The PR #13 class of bug ("contributor
adds a kind in one place but the other 3 declarations silently
reject / drop / mis-render it") is structurally impossible.

### Test count

594 → 612 tests across 59 files. Sanity-check pattern used throughout:
temporarily remove a value from a `KNOWN_*` const, confirm tsc
cascades errors at every consumer, restore.

## [0.2.0-pre.7] — 2026-04-28

User-reported fix: fuzzy project-name matching in Ask. "create an agent
pulse session" (with a space) now correctly resolves to project
`agentpulse`.

### Fixed

- **Ask was failing exact-match resolution on stylistic name variants.**
  Two failures stacked: (1) the keyword gate in `launch-intent-detector.ts`
  used a whole-word regex like `\bagentpulse\b`, which "agent pulse"
  doesn't match, so the LLM classifier never ran and the message fell
  through to the generic Ask path; (2) every project-name resolver used
  exact equality (`toLowerCase()` equality or drizzle `eq()`), so even
  if the gate had passed, "agent pulse" !== "agentpulse" under any of
  them.

  New `src/server/services/projects/project-name-match.ts` adds a
  4-level cascade: exact case-sensitive → case-insensitive → normalized
  (lowercase + strip whitespace / dashes / underscores / dots / parens)
  → Levenshtein distance ≤ 2 typo, but **only when uniquely closest**.
  "Agent Pulse" / "agent-pulse" / "agent_pulse" / "Agent.Pulse" /
  "(agent pulse)" all normalize to `agentpulse` and match. Typos like
  "agnetpulse" resolve via Levenshtein. Two projects within distance 2
  of the candidate → no fuzzy match; the request falls through to
  `launch_needs_project` disambiguation so the user picks rather than
  AgentPulse guessing wrong. Names with fewer than 4 normalized chars
  don't get typo matching (over-matches short names).

  The gate, `parseLaunchIntentResponse`, and the `findProjectByName`
  helper used by edit / delete CRUD actions all route through the
  shared matcher. The classifier system prompt now also tells the LLM
  to normalize whitespace, dashes, and minor typos before emitting
  `projectName` — belt-and-braces; the gate + resolver fix is the real
  safety net.

  Resolved names always surface in the HITL approval card before any
  write, so fuzzy is never silently destructive.

### Test count

565 → 587 tests across 57 files.

## [0.2.0-pre.6] — 2026-04-28

Follow-up patch to the v0.2.0-pre.5 code-health remediation. The DB-1
slice surfaced a latent rollback bug; this release closes it everywhere.

### Fixed

- **Latent `db.transaction(async (tx) => …)` rollback bug at 4 call
  sites** (`control-actions.ts:341` `finalizeCleanupWorkArea`,
  `projects-service.ts:53` `resolveAllSessionsForProject`,
  `projects-service.ts:165` `updateProject` cwd-change branch,
  `projects-service.ts:260` `deleteProject`). drizzle's bun-sqlite
  `db.transaction()` is synchronous — an `async (tx) => …` callback
  returns a Promise immediately, so the BEGIN/COMMIT only brackets the
  sync portion of the callback, the COMMIT fires before any awaited
  statement settles, and a thrown error after an `await` boundary
  cannot roll back. Each site converted to a sync callback using
  `.run()` / `.all()`. Async work that legitimately belonged outside
  the tx (e.g. `bumpVersionAndReload()`) was already correctly placed
  and stayed put.

  Each conversion ships with a rollback parity test that attaches a
  temporary `BEFORE-INSERT/UPDATE/DELETE` trigger raising `ABORT` on
  the second write in the chain, then asserts the first write was
  rolled back. Verified by temporarily reverting each fix and
  confirming each test catches the autocommit (single-write tests
  don't expose the bug — all four use multi-write designs).

  After: `rg 'db\.transaction\(async' src/` returns 0 hits.

### Test count

561 → 565 tests across 56 files.

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

- Docker image: `ghcr.io/jstuart0/agentpulse:latest` (linux/amd64).
- Kubernetes manifests under `deploy/k8s/` target the `thor` cluster
  with Authentik SSO + Traefik IngressRoute.
- Local install: `docker run -d -p 127.0.0.1:3000:3000 -v agentpulse-data:/app/data -e DISABLE_AUTH=true`.
- Remote hook relay: `curl -sSL https://server/setup-relay.sh | bash -s -- --key ap_xxx`.

[Unreleased]: https://github.com/jstuart0/agentpulse/compare/v0.2.0-pre.3...HEAD
[0.2.0-pre.3]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.3
[0.2.0-pre.2]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.2
[0.2.0-pre.1]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.1
[0.1.0]: https://github.com/jstuart0/agentpulse/releases/tag/v0.1.0
