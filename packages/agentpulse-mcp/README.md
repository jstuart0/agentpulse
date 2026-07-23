# agentpulse-mcp

Standalone MCP (Model Context Protocol) server for [AgentPulse](https://github.com/jstuart0/agentpulse) — talk to any running AgentPulse instance from Claude Code, Codex CLI, or any other MCP-compatible client, without cloning the AgentPulse repo.

> **Canonical source**: this package is published from [`github.com/jstuart0/agentpulse`](https://github.com/jstuart0/agentpulse), directory `packages/agentpulse-mcp/`. Verify you're installing `agentpulse-mcp` from npm's canonical listing before trusting it — near-miss names (`agent-pulse-mcp`, `agentpulse-mcp-cli`, …) are typosquat vectors once a package name is public. If this package isn't yet on npm when you read this, run the MCP server from a checkout of the main repo instead (`agentpulse mcp serve` / `agentpulse mcp install`) — see [`docs/MCP.md`](https://github.com/jstuart0/agentpulse/blob/main/docs/MCP.md) there.

**Compatibility**: requires AgentPulse `main` (the future `0.6.0` release) or later — specifically, the release whose `GET /auth/me` reports API-key `scopes`. Older servers fail fast at startup with an upgrade message rather than silently registering a broken tool set.

## Quickstart

```bash
# Mint an observe-only (read-only) key and print client config — the default, safe choice
npx agentpulse-mcp install --mint my-agent

# Mint a manage-scoped key that can also launch/steer/decide (read Security first)
npx agentpulse-mcp install --mint my-agent --orchestrate

# Reuse an existing key instead of minting a new one
npx agentpulse-mcp install --key ap_your_existing_key

# Point at a remote AgentPulse instance
npx agentpulse-mcp install --mint my-agent --url https://agentpulse.example.com
```

`install` never writes files for you — it prints three ready-to-paste blocks (Claude Code one-shot command, `.mcp.json`, Codex `config.toml`, each pinned to this package's own installed version) plus an `export AGENTPULSE_API_KEY=...` line. Reusing `--key` runs a preflight against `/auth/me` first and refuses to print a config for a key that doesn't actually hold the scope you asked for.

To run the server directly (e.g. you already have a key and want to write the client config by hand):

```bash
npx agentpulse-mcp serve
```

`bunx agentpulse-mcp serve` works identically if you have Bun installed. It reads `AGENTPULSE_URL` (defaults to `http://localhost:3000`) and `AGENTPULSE_API_KEY` from the environment and speaks MCP over stdio.

## Tool catalog

Tools span three tiers: `observe`-scoped reads, additional `manage`-only reads (their DTOs carry secrets or operator-authored content), and `manage`-scoped mutations — plus 3 read-only `@`-mentionable Claude Code resources. See the full per-tool catalog, wrapped-endpoint table, and the list of deliberately-excluded operations in the main repo's [`docs/MCP.md`](https://github.com/jstuart0/agentpulse/blob/main/docs/MCP.md#tool-catalog) — this package's tool set, schemas, output caps, and scope gating are byte-identical to what's documented there.

## Security

This is the load-bearing section. Read it before minting a `manage`-scoped key.

**`requiresUserInteraction` (rUI) is a host-side convention, not a protocol-enforced gate.** AgentPulse stamps `_meta["anthropic/requiresUserInteraction"]: true` on every mutating tool. Claude Code's UI honors that flag and prompts you before running the tool. Codex CLI does not — and Codex's own global `approval_policy` setting does **not** gate MCP tool calls either (confirmed against [codex#15437](https://github.com/openai/codex/issues/15437); even `approval_policy = "never"` still let MCP writes through). The only real gate for Codex is the per-server `default_tools_approval_mode` key under `[mcp_servers.agentpulse]`, which `install --orchestrate` emits as `"writes"` (auto-runs read-only tools, prompts before mutating ones). Any other scripted or headless MCP client honors neither mechanism unless you've built confirmation into it yourself — a mutating tool call executes immediately.

**A `manage`-scoped key is unattended, full operator control.** It can spawn and kill agent processes, inject prompts into a live session as if you'd typed them, and approve or deny items in the human-in-the-loop review queue — bypassing the human review that queue exists to provide. Mint `observe` (the default) unless you specifically need orchestration, and treat a `manage` key like a production infrastructure credential, not a convenience toggle.

**Session transcripts are visible to `observe` keys**, and may contain whatever the observed agent itself printed — including incidental secrets in `tool_input`/`tool_response` payloads. This is inherent to observability (AgentPulse doesn't redact agent-authored transcript content on this read path today) and is accepted as residual risk, not a bug. `observe` is only guaranteed secret-free at the *AgentPulse-held-credential* boundary (env vars, launch specs, claim tokens, HITL/action-request payloads).

**Point `AGENTPULSE_URL` only at a server you control.** The client sends your Bearer API key to whatever host that URL resolves to; `serve` prints a warning to stderr (never blocks) when the resolved host isn't `localhost`/`127.0.0.1`/`::1`.

**`DISABLE_AUTH=true` plus a `manage`-scoped MCP key is no scope boundary at all.** Under `DISABLE_AUTH`, every caller (including this MCP server) is treated as fully authenticated with every scope. This combination is intended for trusted local use only.

### Supply-chain: exact-pin every emitted config, review before bumping

Every config `install` emits (`claude mcp add`, `.mcp.json`, `config.toml`) pins this package to an **exact version** — `agentpulse-mcp@<version>`, never a bare or ranged spec. This is a deliberate choice, not an oversight: an unpinned `npx -y agentpulse-mcp serve` means a compromised npm publish silently reaches every fleet-control client on its next MCP-host restart, with zero review step. For a credential that can spawn/kill agents and approve human-in-the-loop review items, that's the wrong tradeoff.

**If you're running a `--orchestrate` (manage-scoped) install**: treat a version bump as a security-relevant change. Read the release before bumping the pin — re-run `agentpulse-mcp install` (or hand-edit the `@<version>` in your existing config) only after reviewing what changed. Don't script an automatic bump for a `manage`-scoped client. `observe`-only installs carry lower stakes but the same discipline is still good hygiene.

Publishing itself uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC) where available — no long-lived npm token exists that could be exfiltrated to push a malicious release; each publish carries [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) you can verify (`npm audit signatures`, or the "Provenance" tab on the npm package page).

### Hardening roadmap / known limitations

Tracked follow-ups in the main repo, not silently accepted gaps — these apply equally whether you run the server via this package or from a checkout:

- **No env-var denylist on launch.** `launch_agent` and the underlying REST launch pipeline accept an arbitrary `env` map without rejecting known-dangerous names (`LD_PRELOAD`, `NODE_OPTIONS`, `*_PROXY`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`, ...).
- **No per-action attribution.** MCP-originated mutations record the same `requestedBy` as any other caller — there's no `origin: "mcp"` tag distinguishing an MCP-driven launch/prompt/decide from a dashboard-driven one in the audit trail.
- **No rate limiting on mutating MCP tools.** Nothing currently throttles repeated `launch_agent`/`prompt_session`/etc. calls from a misbehaving or looping client.
- **No server-side HITL risk-threshold gate.** `decide_hitl`/`decide_action_request` let a `manage`-scoped key approve *any* HITL item, including ones a human would want to review personally for high-risk actions.
- **No server-side recomputation of a submitted `launchSpec`.** `POST /launches` trusts the client-supplied `launchSpec` after reloading the template by id rather than recomputing it fresh.

## Upgrading

Bump the pinned `@<version>` in whatever config you're using:

- Claude Code one-shot: re-run `npx agentpulse-mcp install ...` and re-paste the `claude mcp add` command it prints.
- `.mcp.json` / `~/.codex/config.toml`: hand-edit the `agentpulse-mcp@<old-version>` string to the new version (or re-run `install` and copy the block again).

For a `manage`-scoped install, read the release notes for the version you're bumping to before doing this (see **Supply-chain** above).

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `AGENTPULSE_URL` | `serve`, `install` | `http://localhost:3000` |
| `AGENTPULSE_API_KEY` | `serve`, and as an auth fallback for `install --mint`/`--key` | — |

## Related

- Main repo: <https://github.com/jstuart0/agentpulse>
- In-repo canonical docs: [`docs/MCP.md`](https://github.com/jstuart0/agentpulse/blob/main/docs/MCP.md) (full tool catalog, wrapped-endpoint table, deliberately-excluded operations)
- License: MIT
