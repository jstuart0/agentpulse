# Changelog

All notable changes to AgentPulse are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and — while the
project is still pre-1.0 — breaking changes land under the regular `Changed`
section with a `⚠ breaking` prefix so they're easy to spot.

## [Unreleased]

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

[Unreleased]: https://github.com/jstuart0/agentpulse/compare/v0.2.0-pre.1...HEAD
[0.2.0-pre.1]: https://github.com/jstuart0/agentpulse/releases/tag/v0.2.0-pre.1
[0.1.0]: https://github.com/jstuart0/agentpulse/releases/tag/v0.1.0
