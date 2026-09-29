# Sanitized Codex 0.145 rollout fixture

`rollout-sanitized.jsonl` is a synthetic rollout file, shaped to match the
`codex-cli 0.145.0` rollout record format (`session_meta`, `turn_context`,
`response_item`, `event_msg`, and the forward-compat record types the
observer intentionally ignores: `developer`, `reasoning`, `world_state`,
`token_count`, `custom_tool_call`).

## Provenance

Constructed for AGEN-16 from the field shapes
`src/supervisor/services/codex-observer.ts` already parses, plus the
additional record/kind names identified from local rollout sampling of
`codex-cli 0.145.0` (`session_meta`, `turn_context`,
`event_msg/task_started`, `event_msg/task_complete`, `developer`,
`reasoning`, `world_state`, `token_count`, `response_item/custom_tool_call`).

**All text, commands, outputs, session ids, working directories, and
tool-call ids in this file are synthetic.** There are no real paths,
usernames, or session data — `cwd` is a placeholder
(`/workspace/example-project`), `session_meta.payload.id` is the nil UUID
(`00000000-0000-0000-0000-000000000000`; every observer test rewrites it
to a fresh UUID per the harness's per-test isolation rule), and every
`call_id` is a synthetic `call_000Nexample` string.

## What it contains

- one `session_meta` line
- one `turn_context` and one `event_msg/task_started`, both carrying
  `turn_id: "turn-0001"`
- two user-role `response_item` lines: the first begins with
  `<environment_context` (the injected-context item the observer skips
  rather than posting as a real prompt), the second is the typed prompt
- one line each of `developer`, `reasoning`, `world_state`, `token_count`
  — record types the observer must silently skip (no shared `type` with
  anything it handles)
- two `function_call` items (`name: "exec_command"`), each with a matching
  `function_call_output`, using distinct `call_…` ids
- one `custom_tool_call` response item
- three assistant-role `response_item` lines, all within the one turn
- one `event_msg/task_complete`, carrying `turn_id: "turn-0001"` and
  `last_agent_message`

## Native hook fixtures

The native Codex hook fixtures (`PreToolUse`/`PostToolUse`/`Stop`/
`UserPromptSubmit`/`SessionEnd`) are vendored separately, at
`src/server/services/__fixtures__/event-dedup/codex-0.145/` — they are not
part of this rollout fixture.
