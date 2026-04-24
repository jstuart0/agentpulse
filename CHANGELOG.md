# Changelog

All notable changes to AgentPulse are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and — while the
project is still pre-1.0 — breaking changes land under the regular `Changed`
section with a `⚠ breaking` prefix so they're easy to spot.

## [Unreleased]

### Added

- Expanded Ask resolver test coverage — stopword filtering, multi-keyword
  ranking, tie-break ordering, archived-session exclusion, and explicit-id
  order preservation (#10, merged via #11 from @mvanhorn).

### Changed

- `fetchSessionsById(ids)` in `src/server/services/ask/resolver.ts` now
  returns rows in the caller's input order instead of SQLite's
  insertion/rowid order. Internal callers don't rely on ordering, so no
  runtime impact — but if you were importing this helper directly, you
  can now trust the result to match your input list.

### Fixed — documentation

- **Postgres backend is not yet implemented.** The README, wiki
  (Architecture, Deployment, FAQ, Roadmap) previously claimed Postgres
  support via `DATABASE_URL`. The env var is parsed but downstream code
  ignores it — setting `DATABASE_URL=postgres://…` silently falls back
  to SQLite with a warning log. Docs now say so clearly, point to the
  tracking issue (#12), and drop the "multi-replica via Postgres"
  claim from the Scale-out section. Full phased backend-port plan is
  in `thoughts/2026-04-24-postgres-backend-plan.md`.

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

[Unreleased]: https://github.com/jstuart0/agentpulse/compare/v0.2.0-pre.1...HEAD
[0.2.0-pre.1]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.1
[0.1.0]: https://github.com/jstuart0/agentpulse/releases/tag/v0.1.0
