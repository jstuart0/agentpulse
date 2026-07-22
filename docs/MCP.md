# MCP server

AgentPulse ships a [Model Context Protocol](https://modelcontextprotocol.io) server so an external AI coding agent (Claude Code, Codex CLI, or any MCP-compliant client) can observe and orchestrate your fleet directly, without going through the dashboard. It talks stdio, wraps the same `/api/v1` REST surface the dashboard uses, and authenticates with a scoped AgentPulse API key.

Implementation: `src/mcp/` (client, server, scopes, errors, output caps, tool registration, resources, install). CLI entry points: `bin/cli.ts`'s `mcp serve` / `mcp install` subcommands. Shipped under ticket AGEN-12.

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
claude mcp add --transport stdio agentpulse --env AGENTPULSE_URL=https://agentpulse.example.com --env AGENTPULSE_API_KEY=ap_your_key -- bunx agentpulse mcp serve
```

Or a project-scoped `.mcp.json` (safe to commit — it expands `${AGENTPULSE_API_KEY}` from your shell, never inlines the key):

```json
{
  "mcpServers": {
    "agentpulse": {
      "type": "stdio",
      "command": "bunx",
      "args": ["agentpulse", "mcp", "serve"],
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
command = "bunx"
args = ["agentpulse", "mcp", "serve"]
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
| `list_sessions` | `GET /sessions` | Filterable by status/agent type/project; each row includes a `managed` boolean. |
| `get_session` | `GET /sessions/:id` | Session detail + last 20 events (previews capped) + `managed` status. |
| `get_session_timeline` | `GET /sessions/:id/timeline` | Paginated event timeline, independent of `get_session`'s 20-event trim. |
| `get_event_context` | `GET /sessions/:id/events/:eventId/context` | Events immediately around a given event id. |
| `get_session_claude_md` | `GET /sessions/:id/claude-md` | The CLAUDE.md content stored for a session. |
| `get_stats` | `GET /sessions/stats` | Dashboard KPI stats. |
| `search` | `GET /search` | Full-text across sessions/events. |
| `get_session_intelligence` | `GET /ai/sessions/:id/intelligence` | AI health classification (requires AI enabled on the server). |
| `get_digest` | `GET /ai/digest` | Cross-session daily digest by project. |
| `get_ai_status` | `GET /ai/status`, optionally `GET /ai/diagnostics` | Diagnostics are opt-in (`include_diagnostics: true`) — fetching them emits a `watcher_run_queued` metric on the server, so routine polling should leave it off. |

5 more read tools require `manage` — their REST DTOs carry secrets or operator-authored content, so they're excluded from the `observe` tier (see Security):

| Tool | Wraps | Why manage-only |
|---|---|---|
| `list_templates` / `get_template` | `GET /templates`(`/:id`) | DTO carries `env` (may hold credentials). |
| `list_launches` / `get_launch` | `GET /launches`(`/:id`) | DTO carries `env`, `launchSpec`, and `claimToken`. |
| `get_inbox` | `GET /ai/inbox` | `action_*` items can embed launch `env`/`claimToken` payloads. |
| `list_projects` | `GET /projects` | DTO carries arbitrary operator-set `notes`/`metadata` and a `githubRepoUrl` that may embed userinfo credentials. |
| `list_hosts` | `GET /api/v1/admin/supervisors` | Admin router; used to pick `requested_supervisor_id` for `launch_agent`. |

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

### What's deliberately excluded (and why)

These are never registered as tools, enforced by a drift-guard test that walks the live tool registry:

- **`delete_session`** (`DELETE /sessions/:id`) — irreversible cascade delete. Too destructive for a single confirmation.
- **`update_settings`**, **`create_api_key`** / **`revoke_api_key`**, **`enroll_supervisor`** / **`rotate_supervisor`** / **`revoke_supervisor`** — admin-plane mutations (settings, credentials, host enrollment). A manage-scoped MCP key is an orchestration credential, not an admin credential.
- **`batch_decline`** — bulk destructive inbox action; no batch-approve exists either, so no batch tool was added for either direction.
- **`ask`** (`POST /ai/ask`) — the natural-language Ask surface can itself launch/mutate. Exposing it as one tool would collapse AgentPulse's per-tool confirmation model into a single opaque "do anything" tool.
- **`fork_session`** / **`resume_session`** — the underlying REST routes (`POST /sessions/:id/fork`, `/resume`) are 501 stubs today; there's nothing to wrap yet.
- Channel read/CRUD, watcher/provider/risk-class/labs mutation, vector-search rebuild — all deliberately out of scope for Phase 1.

## Security

This is the load-bearing section. Read it before minting a `manage`-scoped key.

**`requiresUserInteraction` (rUI) is a host-side convention, not a protocol-enforced gate.** AgentPulse stamps `_meta["anthropic/requiresUserInteraction"]: true` on every mutating tool. Claude Code's UI honors that flag and prompts you before running the tool. Codex CLI does not — and Codex's own global `approval_policy` setting does **not** gate MCP tool calls either (confirmed against [codex#15437](https://github.com/openai/codex/issues/15437); even `approval_policy = "never"` still let MCP writes through). The only real gate for Codex is the per-server `default_tools_approval_mode` key under `[mcp_servers.agentpulse]`, which `mcp install --orchestrate` emits as `"writes"` (auto-runs read-only tools, prompts before mutating ones). Any other scripted or headless MCP client honors neither mechanism unless you've built confirmation into it yourself — a mutating tool call executes immediately.

**A `manage`-scoped key is unattended, full operator control.** It can spawn and kill agent processes, inject prompts into a live session as if you'd typed them, and approve or deny items in the human-in-the-loop review queue — bypassing the human review that queue exists to provide. Mint `observe` (the default) unless you specifically need orchestration, and treat a `manage` key like a production infrastructure credential, not a convenience toggle.

**Session transcripts are visible to `observe` keys**, and may contain whatever the observed agent itself printed — including incidental secrets in `tool_input`/`tool_response` payloads. This is inherent to observability (AgentPulse doesn't redact agent-authored transcript content on this read path today) and is accepted as residual risk, not a bug. `observe` is only guaranteed secret-free at the *AgentPulse-held-credential* boundary (env vars, launch specs, claim tokens, HITL/action-request payloads) — those are the DTOs deliberately excluded from the observe tier, listed above.

**Point `AGENTPULSE_URL` only at a server you control.** The client sends your Bearer API key to whatever host that URL resolves to.

**`DISABLE_AUTH=true` plus a `manage`-scoped MCP key is no scope boundary at all.** Under `DISABLE_AUTH`, every caller (including the MCP server) is treated as fully authenticated with every scope. This combination is intended for trusted local use only.

### Hardening roadmap / known limitations

These are tracked follow-ups, not silently accepted gaps:

- **No env-var denylist on launch.** `launch_agent` and the underlying REST launch pipeline accept an arbitrary `env` map without rejecting known-dangerous names (`LD_PRELOAD`, `NODE_OPTIONS`, `*_PROXY`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`, ...). Pre-existing on the raw `POST /launches` route; MCP makes it reachable in one natural-language-driven call instead of a manual POST.
- **No per-action attribution.** MCP-originated mutations currently record `requestedBy: "local-user"` like every other caller — there's no `origin: "mcp"` tag distinguishing an MCP-driven launch/prompt/decide from a dashboard-driven one in the audit trail.
- **No rate limiting on mutating MCP tools.** Nothing currently throttles repeated `launch_agent`/`prompt_session`/etc. calls from a misbehaving or looping client.
- **No server-side HITL risk-threshold gate.** `decide_hitl`/`decide_action_request` let a `manage`-scoped key approve *any* HITL item, including ones a human would want to review personally for high-risk actions.
- **No server-side recomputation of a submitted `launchSpec`.** `POST /launches` trusts the client-supplied `launchSpec` after reloading the template by id rather than recomputing it fresh — a pre-existing property of the shared launch route (the dashboard's own preview-then-post flow has the same shape), surfaced here because MCP is a new caller of it.

### Remote / SSO deployments

No Kubernetes manifest changes are needed to use the MCP server against a remote, SSO-fronted AgentPulse instance. It authenticates with the same Bearer-token edge bypass the dashboard's hook ingestion already uses (`PathPrefix(/api/) && HeaderRegexp(Authorization, Bearer ap_.*)`), so an MCP client pointed at `https://agentpulse.example.com` works without touching Traefik or Authentik configuration. The client canonicalizes `AGENTPULSE_URL` to `<origin>/api/v1` — pointing it at an `/app-api/v1` base (the browser-facing mount) gets rewritten with a stderr warning, since that path is not covered by the Bearer bypass and would hit forwardauth on a remote deployment.

## Related

- Ticket: AGEN-12
- Plan: `thoughts/shared/plans/2026-07-22-deliver-mcp-server.md`
- State/findings ledger: `thoughts/shared/plans/active/2026-07-22-deliver-mcp-server.state.md`
- Code: `src/mcp/`, `bin/cli.ts`, `src/server/auth/route-scope-policy.ts`
