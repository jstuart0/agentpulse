# Vendored native Codex 0.145 hook fixtures

`PreToolUse.json`, `PostToolUse.json`, `Stop.json`, `UserPromptSubmit.json`,
and `SessionEnd.json` are the native-hook wire shapes Codex CLI's own hook
integration produces on Codex CLI `0.145.0`, vendored verbatim from a
companion Codex/Copilot CLI-integration effort's own fixture set (same repo,
a different piece of work), with each file's original sanitized content
preserved unchanged.

`PermissionRequest.json` is docs-derived (`_source: "docs"` in the file
itself) rather than sampled from a live session, because a live
PermissionRequest wasn't captured during that fixture set's sampling — its
shape is otherwise identical to the other fixtures.

## Why they matter here (AGEN-16)

Every fixture carries `transcript_path` — the one field that distinguishes a
real native Codex hook delivery from a pre-upgrade codex-observer post: the
observer's own `HookPayload` never sets it. `routes/ingest-native-codex.test.ts`
posts these fixtures verbatim through `POST /api/v1/hooks` with
`X-Agent-Type: codex_cli` and no origin header, and asserts they are never
counted as legacy-observer deliveries and that their tool rows get
`t:`-prefixed `dedup_key`s. The same file is re-run once payload
canonicalization sits in front of the ingest handler, to prove
`transcript_path` survives that step too.

## Provenance

Each file's own `_source` field states `"live"` or `"docs"`. `session_id`,
`cwd`, `transcript_path`, and `turn_id` are synthetic/sanitized placeholder
values — no real paths or usernames. Tests that need distinct sessions
override `session_id` after loading the fixture.
