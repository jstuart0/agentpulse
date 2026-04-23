# Changelog

All notable changes to AgentPulse are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and — while the
project is still pre-1.0 — breaking changes land under the regular `Changed`
section with a `⚠ breaking` prefix so they're easy to spot.

## [Unreleased]

Nothing currently unreleased on `main` beyond the sections below.

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

[Unreleased]: https://github.com/jstuart0/agentpulse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jstuart0/agentpulse/releases/tag/v0.1.0
