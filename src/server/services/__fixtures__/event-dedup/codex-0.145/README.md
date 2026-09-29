# Vendored native Codex 0.145 hook fixtures

`PreToolUse.json`, `PostToolUse.json`, `Stop.json`, `UserPromptSubmit.json`,
and `SessionEnd.json` are vendored verbatim from the sibling campaign
(`2026-09-28-deliver-agent-cli-parity`) at
`src/server/services/agents/__fixtures__/codex/` @ commit `1cc2468`
(identical content at `819d2a5`), per the test contract's harness rule 7.
They are the native-hook wire shapes the sibling's Codex integration
produces on Codex CLI `0.145.0`.

`PermissionRequest.json` is docs-derived (`_source: "docs"` in the file
itself) rather than sampled from a live session, because a live
PermissionRequest wasn't captured in the sibling's sampling — its shape is
otherwise identical to the other fixtures.

## Why they matter here (AGEN-16 Phase 7)

Every fixture carries `transcript_path` — the one field that distinguishes a
real native Codex hook delivery from a pre-upgrade codex-observer post
(mozart D14): the observer's own `HookPayload` never sets it. NATIVE1
(`routes/ingest-native-codex.test.ts`) posts these fixtures verbatim through
`POST /api/v1/hooks` with `X-Agent-Type: codex_cli` and no origin header,
and asserts they are never counted as `legacyObserverDeliveries` and that
their tool rows get `t:`-prefixed `dedup_key`s. The same file re-runs
post-merge as E3-canon, once the sibling's `canonicalizeHookPayload` sits in
front of `processHookEvent` in the route — proving `transcript_path`
survives canonicalization.

## Provenance

Each file's own `_source` field states `"live"` or `"docs"`, matching the
sibling's original fixture. `session_id`, `cwd`, `transcript_path`, and
`turn_id` are the sibling's synthetic/sanitized placeholder values — no real
paths or usernames. Tests that need distinct sessions override `session_id`
after loading the fixture (the harness's per-test session-id rule).
