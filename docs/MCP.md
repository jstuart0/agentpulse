# MCP server

AgentPulse ships a [Model Context Protocol](https://modelcontextprotocol.io) server so an external AI coding agent (Claude Code, Codex CLI, or any MCP-compliant client) can observe and orchestrate your fleet directly, without going through the dashboard. It talks stdio, wraps the same `/api/v1` REST surface the dashboard uses, and authenticates with a scoped AgentPulse API key.

The MCP server also ships as a standalone, publishable npm package — **[`@agentpulse/mcp`](../packages/agentpulse-mcp/README.md)** — so it can be installed and run (`npx @agentpulse/mcp serve`) against any AgentPulse instance without cloning this repo. This doc remains the canonical in-repo reference (tool catalog, security posture); the package README covers publish-specific concerns (supply-chain pinning, typosquat guidance).

Implementation: `packages/agentpulse-mcp/src/` (client, server, scopes, errors, output caps, tool registration, resources, install, cli). CLI entry points: this package's own `agentpulse-mcp serve|install`, and — from a checkout — `bin/cli.ts`'s `mcp serve` / `mcp install` subcommands (a thin shim over the package). Shipped under ticket AGEN-12.

## Quickstart

```bash
# Mint an observe-only (read-only) key and print client config — the default, safe choice
agentpulse mcp install --mint my-agent

# Mint a manage-scoped key that can also launch/steer/decide (see Security below first)
agentpulse mcp install --mint my-agent --orchestrate

# Reuse an existing key instead of minting a new one
agentpulse mcp install --key ap_your_existing_key

# Point at a remote AgentPulse instance
agentpulse mcp install --mint my-agent --url https://agentpulse.example.com
```

`mcp install` never writes files for you — it prints three ready-to-paste blocks (Claude Code one-shot command, `.mcp.json`, Codex `config.toml`) plus an `export AGENTPULSE_API_KEY=...` line. Copy what you need. Reusing `--key` runs a preflight against `/auth/me` first and refuses to print a config for a key that doesn't actually hold the scope you asked for (e.g. `--orchestrate` with an observe-only key).

To run the server directly (e.g. because you already have a key and want to write the client config by hand):

```bash
agentpulse mcp serve
```

It reads `AGENTPULSE_URL` (defaults to `http://localhost:3000`) and `AGENTPULSE_API_KEY` from the environment and speaks MCP over stdio.

## Client setup

### Claude Code

One-shot registration:

```bash
claude mcp add --transport stdio agentpulse --env AGENTPULSE_URL=https://agentpulse.example.com --env AGENTPULSE_API_KEY=ap_your_key -- npx -y @agentpulse/mcp@<version> serve
```

(`mcp install` prints this with `<version>` resolved to the exact pinned release — see **Security** for why the pin matters. `bunx` works identically in place of `npx` if you prefer Bun.)

Or a project-scoped `.mcp.json` (safe to commit — it expands `${AGENTPULSE_API_KEY}` from your shell, never inlines the key):

```json
{
  "mcpServers": {
    "agentpulse": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agentpulse/mcp@<version>", "serve"],
      "env": {
        "AGENTPULSE_URL": "https://agentpulse.example.com",
        "AGENTPULSE_API_KEY": "${AGENTPULSE_API_KEY}"
      }
    }
  }
}
```

Claude Code also gets 3 read-only `@`-mentionable resources: `agentpulse://sessions`, `agentpulse://sessions/{sessionId}`, `agentpulse://digest`.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agentpulse]
command = "npx"
args = ["-y", "@agentpulse/mcp@<version>", "serve"]
env = { AGENTPULSE_URL = "https://agentpulse.example.com" }
env_vars = ["AGENTPULSE_API_KEY"]

# --orchestrate only:
default_tools_approval_mode = "writes"
```

`default_tools_approval_mode = "writes"` is emitted automatically by `mcp install` whenever the minted/reused key can orchestrate (`manage` scope). See **Security** below for why this line matters — Codex ignores Claude Code's confirmation mechanism entirely, and this is the only real gate it has.

## Tool catalog

11 read tools require `observe` (register for both observe- and manage-scoped keys). All are `readOnlyHint:true`.

| Tool | Wraps | Notes |
|---|---|---|
| `list_sessions` | `GET /sessions` | Filterable by status/agent type/project/operational state; each row includes a `managed` boolean and (when the server supports it) `operationalStatus`. `agent_type` accepts `claude_code`, `codex_cli`, or `copilot_cli` (Copilot is observed only). `operational` filters by the derived waiting/working/idle/error state (AGEN) rather than the raw lifecycle `status` — a server predating this filter ignores the param and returns its normal unfiltered page. `owner` scopes the list and its `total` to one owner's sessions: `me` (the user the key belongs to), a user id, `unassigned` (no owner, no recorded key), `service` (no owner, reported by a key) or `all` (the default); each row carries `ownerUserId` and `ownerKind`. A server predating owner scoping would ignore `owner` and answer with everyone's sessions, so when `owner` is anything but `all` the response must carry an `ownerScope` echo of the scope the server applied (`{kind, userId?}`; `me` echoes with the user id it resolved to), and the tool returns an error instead of the list when the echo is missing or is not the scope asked for. For `me` the server also refuses a key with no owning user. `host` narrows the list and its `total` to one machine by its exact name (case-sensitive) and `no_host` to the sessions with no machine at all (use one or the other); each row carries `machine`, the name the server files it under: the supervisor's host for a supervisor-launched session, else the name its relay reported, else null. A machine name is self-declared by whatever sent the events, so it is for display and filtering only and says nothing about who may see or change a session. As with `owner`, the response must carry a `hostFilter` echo (`{kind: "all" | "unknown" | "host", host?}`) of what the server applied, and the tool returns an error instead of the list when a machine was asked for and the echo is missing or different (a server predating the filter ignores `host`), or when an echo claims a filter nobody asked for. A name with control characters or over 256 characters is rejected before any request. The orchestration tools below (`recommend_launch`, `create_template`, `list_templates`) accept only `claude_code`/`codex_cli` for their own `agent_type` fields — Copilot can't be launched. An unrecognized `agent_type` filter value 400s with the rejected value and the allowed list (AGEN-44) rather than silently returning zero results; a server predating AGEN-44 still returns zero for that case. |
| `get_session` | `GET /sessions/:id` | Session detail + last 20 events (previews capped) + `managed` status. `session.nameSource` (`"user"`\|`"native"`\|`"generated"`) and `session.nativeName` report whether the session's name was manually renamed, pulled from the agent, or generated; `list_sessions`' compact rows omit both. Also carries the acknowledgement-model fields (AGEN) — `lastAgentTurnCompletedAt`, `lastUserAcknowledgedAt`, and the derived `operationalStatus` (`"waiting"`\|`"working"`\|`"idle"`\|`"error"`\|`"completed"`) — `list_sessions`' compact rows include `operationalStatus` too (same field), but omit `lastAgentTurnCompletedAt`/`lastUserAcknowledgedAt`. |
| `get_session_timeline` | `GET /sessions/:id/timeline` | Paginated event timeline, independent of `get_session`'s 20-event trim. |
| `get_event_context` | `GET /sessions/:id/events/:eventId/context` | Events immediately around a given event id. |
| `get_session_claude_md` | `GET /sessions/:id/claude-md` | The CLAUDE.md content stored for a session. |
| `get_stats` | `GET /sessions/stats` | Dashboard KPI stats, plus the four operational counts (AGEN): `operational.{waiting,working,idle,error}`. `owner` (same values and the same echo requirement as `list_sessions`) scopes every count to that owner's sessions; the response carries `ownerScope` and `total` (every session in the applied scope). `host` / `no_host` (same values and the same `hostFilter` echo requirement as `list_sessions`) scope every count to one machine and combine with `owner`. |
| `search` | `GET /search` | Full-text across sessions/events. `agentType` filter validated the same way as `list_sessions` (AGEN-44). |
| `get_session_intelligence` | `GET /ai/sessions/:id/intelligence` | AI health classification (requires AI enabled on the server). |
| `get_digest` | `GET /ai/digest` | Cross-session daily digest by project. |
| `get_ai_status` | `GET /ai/status`, optionally `GET /ai/diagnostics` | Diagnostics are opt-in (`include_diagnostics: true`) — fetching them emits a `watcher_run_queued` metric on the server, so routine polling should leave it off. |
| `list_projects_summary` | `GET /projects/summary` | Observe-safe project list: `id`/`name`/defaults, with `githubRepoUrl` reduced to `origin`+`pathname`. Narrower sibling of the manage-only `list_projects` below. |

5 more read tools require `manage` — their REST DTOs carry secrets or operator-authored content, so they're excluded from the `observe` tier (see Security):

| Tool | Wraps | Why manage-only |
|---|---|---|
| `list_templates` / `get_template` | `GET /templates`(`/:id`) | DTO carries `env` (may hold credentials). `list_templates`' `agent_type` filter is validated the same way as `list_sessions` (AGEN-44). |
| `list_launches` / `get_launch` | `GET /launches`(`/:id`) | DTO carries `env`, `launchSpec`, and `claimToken`. |
| `get_inbox` | `GET /ai/inbox` | `action_*` items can embed launch `env`/`claimToken` payloads. |
| `list_projects` | `GET /projects` | DTO carries arbitrary operator-set `notes`/`metadata` and a `githubRepoUrl` that may embed userinfo credentials. Need only the id/name/defaults? Use the observe-scoped `list_projects_summary` above instead. |
| `list_hosts` | `GET /api/v1/admin/supervisors` | Admin router; used to pick `requested_supervisor_id` for `launch_agent`. Each host may carry `excludeRulesState`: `"invalid"` when the exclude file on that host has an error and its supervisor is sending no session data until it is fixed, otherwise `null` or absent (the server keeps no other state). |

12 tools require `manage` and mutate state. All except the two advisory ones carry `_meta["anthropic/requiresUserInteraction"]` (rUI):

| Tool | Wraps | Notes |
|---|---|---|
| `recommend_launch` | `POST /launches/recommendation` | Advisory, side-effect-free. No rUI. |
| `preview_template` | `POST /templates/preview` | Simulates resolving a template into a launch spec. Side-effect-free. No rUI. |
| `launch_agent` | `POST /launches` (+ `GET /templates/:id` + `POST /templates/preview` when launching by `template_id`) | Spawns a real agent process. rUI. Exactly one of `template_id` alone, or `template`+`launch_spec` together — partial combinations are rejected. |
| `prompt_session` | `POST /sessions/:id/prompt` | Injects a prompt into a live agent, as if typed into its terminal. rUI. Managed sessions only. |
| `stop_session` | `POST /sessions/:id/stop` | Stops a live agent's process. rUI. Managed sessions only. |
| `retry_launch` | `POST /sessions/:id/retry` | Re-launches a session's original request as a new one. rUI. Managed sessions only. |
| `update_session` | `PUT /sessions/:id/{notes,rename,pin,archive}` | One or more fields per call; each field applies independently. rUI. Result reports per-field `applied`/`failed`; only errors if every requested field failed. |
| `create_template` / `update_template` | `POST /templates`, `PUT /templates/:id` | rUI. |
| `delete_template` | `DELETE /templates/:id` | rUI + `destructiveHint`. |
| `decide_hitl` | `POST /ai/inbox/hitl/:id/decide` | Approve/decline/reply-with-custom-prompt a single HITL request. rUI. |
| `decide_action_request` | `POST /ai/action-requests/:id/decide` | Approve/decline a single pending action request. rUI. |

"Managed sessions only" means AgentPulse rejects the call with `"Session is not managed."` for any session the server isn't holding a live process for (hook-observed-only sessions).

### Team mode (AGEN-64)

When the server runs in team mode (see the README's "Teams" section), a key's authority follows its owner:

- **A key a person owns acts as that person**, with the role they have *now* (read with the key on every request, so demoting an admin takes admin power from their keys at once). `agentpulse mcp install --mint`, run with a key a member owns, mints a key owned by that member.
- **An ownerless key (a service key)** acts as a member, even with `manage` scope, unless an admin has kept it as an *admin service key*. In solo mode an ownerless `manage` key keeps its old admin-equivalent authority. With `AGENTPULSE_MODE=team` set in the environment, existing ownerless `manage` keys become members until an admin lists them, so a tool or script using one for settings or key management now gets `403 admin_required`.
- **A key whose owner is disabled is refused**; one whose owner must still replace a generated password gets `403 password_change_required` until they do.
- **`observe` still reads everything.** Team mode records who owns a session; it doesn't hide anything. Every `observe` key reads every session's prompts, events, notes, names, hosts and launch outcomes. Filtering by `owner` is a view, not access control.
- **What `manage` can and can't do to other people's sessions.** `prompt_session`, `stop_session`, `retry_launch` and `launch_agent` aren't owner-checked: any `manage` key can use them on any managed session or host. `update_session` (notes, rename, pin, archive) needs the session's owner or an admin; a field the key's owner may not change comes back in the result's `failed` list. A launch that the host's supervisor refuses because the directory is excluded fails with the same generic message as a trusted-roots refusal, so the error doesn't say which it was (the server's own request-time check of the trusted roots is unchanged and still names the problem).
- **`list_sessions` and `get_stats` also take `host` / `no_host`** (a machine filter, see their rows above): a view, never access control, and the machine name is self-declared, so nothing should be decided from it.
- **`list_sessions` and `get_stats` take `owner`** (see their rows above), with the echo requirement: a server that predates owner scoping would silently answer with everyone's sessions, so the tool refuses an answer whose `ownerScope` doesn't match what it asked for. Use `me` for your own sessions; the server refuses it for a key with no owning user.
- **`get_session`'s `reportedByKey`** (the name of the key that first reported the session, and whether it is a service key) is returned only to `manage` callers, and in team mode only to an admin, the session's owner and the key's owner; for anyone else it is omitted entirely. The key's id is never returned.
- **`GET /users/directory`** answers `observe` keys: for everyone who can own something, `{ id, displayName, disabled, authSource }` and nothing else. It is a REST route; there is no MCP tool for it. Use it to turn a person into the user id that `owner` takes. The rest of `/users` (list, create, disable, reset password) is for admins, and every change refuses an API key outright.
- **`list_hosts`** returns `ownerUserId` per host, and `excludeRulesState` (above). Owning a host controls who may rotate or revoke it, not who may launch on it.

### What's deliberately excluded (and why)

These are never registered as tools, enforced by a drift-guard test that walks the live tool registry:

- **`delete_session`** (`DELETE /sessions/:id`) — irreversible cascade delete. Too destructive for a single confirmation.
- **`update_settings`**, **`create_api_key`** / **`revoke_api_key`**, **`enroll_supervisor`** / **`rotate_supervisor`** / **`revoke_supervisor`** — admin-plane mutations (settings, credentials, host enrollment). A manage-scoped MCP key is an orchestration credential, not an admin credential.
- **`batch_decline`** — bulk destructive inbox action; no batch-approve exists either, so no batch tool was added for either direction.
- **`ask`** (`POST /ai/ask`) — the natural-language Ask surface can itself launch/mutate. Exposing it as one tool would collapse AgentPulse's per-tool confirmation model into a single opaque "do anything" tool.
- **`fork_session`** / **`resume_session`** — the underlying REST routes (`POST /sessions/:id/fork`, `/resume`) are 501 stubs today; there's nothing to wrap yet.
- Channel read/CRUD, watcher/provider/risk-class/labs mutation, vector-search rebuild — all deliberately out of scope for Phase 1.

## Security

This is the load-bearing section. Read it before minting a `manage`-scoped key. (If you're running the standalone `@agentpulse/mcp` npm package, its README carries this section verbatim plus two publish-specific additions: exact-version-pin guidance for `--orchestrate`/`manage` installs, and a typosquat/canonical-source warning.)

**`requiresUserInteraction` (rUI) is a host-side convention, not a protocol-enforced gate.** AgentPulse stamps `_meta["anthropic/requiresUserInteraction"]: true` on every mutating tool. Claude Code's UI honors that flag and prompts you before running the tool. Codex CLI does not — and Codex's own global `approval_policy` setting does **not** gate MCP tool calls either (confirmed against [codex#15437](https://github.com/openai/codex/issues/15437); even `approval_policy = "never"` still let MCP writes through). The only real gate for Codex is the per-server `default_tools_approval_mode` key under `[mcp_servers.agentpulse]`, which `mcp install --orchestrate` emits as `"writes"` (auto-runs read-only tools, prompts before mutating ones). Any other scripted or headless MCP client honors neither mechanism unless you've built confirmation into it yourself — a mutating tool call executes immediately.

**A `manage`-scoped key is unattended, full operator control.** It can spawn and kill agent processes, inject prompts into a live session as if you'd typed them, and approve or deny items in the human-in-the-loop review queue — bypassing the human review that queue exists to provide. Mint `observe` (the default) unless you specifically need orchestration, and treat a `manage` key like a production infrastructure credential, not a convenience toggle.

**Session transcripts are visible to `observe` keys**, and may contain whatever the observed agent itself printed — including incidental secrets in `tool_input`/`tool_response` payloads. This is inherent to observability (AgentPulse doesn't redact agent-authored transcript content on this read path today) and is accepted as residual risk, not a bug. `observe` is only guaranteed secret-free at the *AgentPulse-held-credential* boundary (env vars, launch specs, claim tokens, HITL/action-request payloads) — those are the DTOs deliberately excluded from the observe tier, listed above.

**`rawPayload` shape (AGEN-16):** for hook tool and permission event rows (`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PermissionRequest`/`PermissionDenied`), `rawPayload.tool_input` is omitted (`rawPayload.tool_input_in_column: true` marks it) — read the event's `toolInput` field instead, which always carries the same value. `rawPayload.tool_response` on a `PostToolUse`/`PostToolUseFailure` row is capped at 4,096 characters (`rawPayload.tool_response_truncated`/`tool_response_chars` when it was cut); the `toolResponse` field is capped tighter, at 2,000. No MCP tool in this package reads `rawPayload.tool_input` today, so this is informational for anyone building against the raw event shape directly.

**Point `AGENTPULSE_URL` only at a server you control.** The client sends your Bearer API key to whatever host that URL resolves to.

**`DISABLE_AUTH=true` plus a `manage`-scoped MCP key is no scope boundary at all.** Under `DISABLE_AUTH`, every caller (including the MCP server) is treated as fully authenticated with every scope. This combination is intended for trusted local use only.

### Hardening roadmap / known limitations

These are tracked follow-ups, not silently accepted gaps:

- **No env-var denylist on launch.** `launch_agent` and the underlying REST launch pipeline accept an arbitrary `env` map without rejecting known-dangerous names (`LD_PRELOAD`, `NODE_OPTIONS`, `*_PROXY`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`, ...). Pre-existing on the raw `POST /launches` route; MCP makes it reachable in one natural-language-driven call instead of a manual POST.
- **No per-caller-tool attribution.** MCP-originated mutations record `requestedBy`/`requestedByUserId` exactly like any other API-key caller — `requestedBy: "api_key"` and `requestedByUserId` set to the key's owner (or `null` for an ownerless/service key) — because the MCP server authenticates with a Bearer API key like anything else hitting the REST API. There's no `origin: "mcp"` tag distinguishing an MCP-driven launch/prompt/decide from a raw `curl` using the same key in the audit trail.
- **No rate limiting on mutating MCP tools.** Nothing currently throttles repeated `launch_agent`/`prompt_session`/etc. calls from a misbehaving or looping client.
- **No server-side HITL risk-threshold gate.** `decide_hitl`/`decide_action_request` let a `manage`-scoped key approve *any* HITL item, including ones a human would want to review personally for high-risk actions.
- **No server-side recomputation of a submitted `launchSpec`.** `POST /launches` trusts the client-supplied `launchSpec` after reloading the template by id rather than recomputing it fresh — a pre-existing property of the shared launch route (the dashboard's own preview-then-post flow has the same shape), surfaced here because MCP is a new caller of it. One field is the exception: `launchSpec.launchCorrelationId` is always server-generated and the submitted value is silently ignored (see "Launch correlation ids" below) — every other field in `launch_spec` is still trusted as-submitted.

### Launch correlation ids

`launch_spec.launchCorrelationId` is an optional field on `launch_agent`'s input schema — still accepted when present (so `preview_template`'s output can be passed straight through unchanged), but the server never honors a caller-supplied value: `POST /launches` always mints a fresh one and the tool's own schema description says so. Earlier, a `manage`-scoped caller could set this field to an existing or guessed-future session id and have that session silently attached to its launch on the session's next `SessionStart`, hijacking ownership (queued prompt/stop actions become claimable by the attacker's supervisor). No legitimate caller — including `launch_agent` itself — ever needed its own value honored, so the fix is a silent server-side override rather than a new input-validation error. Read the authoritative id from the returned `launchRequest.launchCorrelationId`.

### Remote / SSO deployments

No Kubernetes manifest changes are needed to use the MCP server against a remote, SSO-fronted AgentPulse instance. It authenticates with the same Bearer-token edge bypass the dashboard's hook ingestion already uses (`PathPrefix(/api/) && HeaderRegexp(Authorization, Bearer ap_.*)`), so an MCP client pointed at `https://agentpulse.example.com` works without touching Traefik or Authentik configuration. The client canonicalizes `AGENTPULSE_URL` to `<origin>/api/v1` — pointing it at an `/app-api/v1` base (the browser-facing mount) gets rewritten with a stderr warning, since that path is not covered by the Bearer bypass and would hit forwardauth on a remote deployment.

## Related

- Standalone npm package: [`packages/agentpulse-mcp/`](../packages/agentpulse-mcp/README.md) — publish-ready `@agentpulse/mcp`, installable outside this repo
- Ticket: AGEN-12
- Plan (original MCP server): `thoughts/shared/plans/2026-07-22-deliver-mcp-server.md`
- Plan (package extraction): `thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md`
- Code: `packages/agentpulse-mcp/src/`, `bin/cli.ts` (in-repo shim), `src/server/auth/route-scope-policy.ts`
