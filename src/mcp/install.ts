/**
 * `agentpulse mcp install` (AGEN-12 Phase 5, plan D4).
 *
 * Pure, unit-testable functions only — no console output here. rUI
 * (`_meta["anthropic/requiresUserInteraction"]`) is a Claude-Code-only
 * `_meta` extension; Codex CLI and any scripted/headless MCP client execute
 * mutating tools without a confirmation prompt (xander, mid-build security
 * review). Because the protocol-level gate can't be relied on, the INSTALL
 * FLOW'S DEFAULTS are the real safety mechanism:
 *
 *   - default minted scope is `["observe"]` (read-only, secret-free at the
 *     REST boundary post-C1);
 *   - `--orchestrate` opts into `["observe","manage"]` and MUST print
 *     ORCHESTRATE_WARNING — required output, not optional prose;
 *   - the Codex config block gets a `default_tools_approval_mode` governance
 *     line whenever the key can orchestrate, since Codex's own approval
 *     mode is the only gate rUI can't provide there (H2).
 *
 * `console.log` is banned under src/mcp/** (check:no-console-log-mcp — the
 * stdio transport owns stdout for `mcp serve`'s JSON-RPC stream). This
 * module therefore never prints; bin/cli.ts's `mcp install` handler calls
 * `runInstall()` and prints the returned blocks itself.
 */
import { SCOPE_MANAGE, SCOPE_OBSERVE } from "../server/auth/api-key.js";
import type { AgentPulseClient, CreateApiKeyResult } from "./client.js";
import { ScopeDiscoveryError, discoverScopes } from "./scopes.js";

// ─── Emitters ───────────────────────────────────────────────────────

export interface EmitConfigParams {
	url: string;
	/** The API key value. Only emitClaudeCommand ever inlines it literally
	 * — see each function's own doc comment for why. */
	keyRef: string;
}

export interface EmitCodexTomlParams extends EmitConfigParams {
	/** True when the minted/reused key holds "manage" — H2's governance line. */
	canOrchestrate: boolean;
}

/**
 * `claude mcp add` is a one-shot shell command the operator runs and copies
 * from their own terminal — it is never written to a git-destined file, so
 * inlining the literal key here (via --env, matching Claude Code's own
 * registration mechanism) is the correct and only sane behavior.
 */
export function emitClaudeCommand({ url, keyRef }: EmitConfigParams): string {
	return `claude mcp add --transport stdio agentpulse --env AGENTPULSE_URL=${url} --env AGENTPULSE_API_KEY=${keyRef} -- bunx agentpulse mcp serve`;
}

/**
 * `.mcp.json` is Claude Code's PROJECT-scope config — shareable and
 * routinely committed to git. `params.keyRef` is deliberately never read
 * here: the emitted key is always Claude Code's own `${VAR}` env-expansion
 * syntax, regardless of what value the caller passes as keyRef. This is a
 * structural guarantee, not caller discipline — a mistake upstream (e.g.
 * accidentally passing a real key as keyRef) cannot leak through this
 * function because the function never looks at it for the secret field.
 */
export function emitMcpJson(params: EmitConfigParams): string {
	const doc = {
		mcpServers: {
			agentpulse: {
				type: "stdio",
				command: "bunx",
				args: ["agentpulse", "mcp", "serve"],
				env: {
					AGENTPULSE_URL: params.url,
					AGENTPULSE_API_KEY: "${AGENTPULSE_API_KEY}",
				},
			},
		},
	};
	return JSON.stringify(doc, null, 2);
}

const ORCHESTRATE_APPROVAL_COMMENT = `# --orchestrate: this key is scoped "observe"+"manage" — it can spawn/kill
# agents, inject prompts into live sessions, and decide human-in-the-loop
# review items. Codex CLI does NOT honor MCP's _meta.requiresUserInteraction
# hint (a Claude-Code-only extension), and Codex's GLOBAL approval_policy
# does NOT gate raw MCP tool calls either (codex#15437 — even
# approval_policy="never" still prompted on MCP writes). This per-server
# default_tools_approval_mode key is the ONLY real gate for this server's
# tool calls (codex PR #17843). "writes" auto-runs AgentPulse's read tools
# (registered with readOnlyHint:true, enforced by our drift guard) and
# prompts before any mutating tool — frictionless reads, confirmed
# mutations. Requires a Codex CLI version with per-server MCP approval
# (~April 2026+). For finer-grained control than trusting readOnlyHint,
# override per tool: [mcp_servers.agentpulse.tools.<tool_name>]
# approval_mode = "prompt".`;

/**
 * `~/.codex/config.toml`'s `[mcp_servers.agentpulse]` stdio block. Same
 * never-inline-the-key guarantee as emitMcpJson (params.keyRef is
 * deliberately unread) — `env_vars` is Codex's passthrough-by-name
 * mechanism (research Q4), inheriting whatever value is set in the
 * operator's own shell rather than embedding a literal.
 */
export function emitCodexToml(params: EmitCodexTomlParams): string {
	const lines = [
		"[mcp_servers.agentpulse]",
		'command = "bunx"',
		'args = ["agentpulse", "mcp", "serve"]',
		`env = { AGENTPULSE_URL = "${params.url}" }`,
		'env_vars = ["AGENTPULSE_API_KEY"]',
	];
	if (params.canOrchestrate) {
		lines.push("", ORCHESTRATE_APPROVAL_COMMENT, 'default_tools_approval_mode = "writes"');
	}
	return lines.join("\n");
}

// ─── Orchestrate warning (required output) ─────────────────────────

export const ORCHESTRATE_WARNING = `WARNING: --orchestrate mints (or requires) a "manage"-scoped key.
This key grants UNATTENDED, FULL operator control over your entire
AgentPulse fleet: it can spawn and kill agents, inject prompts into live
sessions, and decide (approve/deny) items in the human-in-the-loop review
queue.

AgentPulse's mutating MCP tools are marked with
_meta["anthropic/requiresUserInteraction"], but that flag is honored ONLY
by hosts that implement it (Claude Code's permission UI). Codex CLI and any
scripted/headless MCP client execute these tools WITHOUT any confirmation
prompt.

Only use --orchestrate for a client you trust to gate its own mutating tool
calls (e.g. Codex's default_tools_approval_mode = "writes", emitted below),
and store the resulting key like any other credential capable of
controlling production infrastructure.`;

// ─── Mint / scope selection ─────────────────────────────────────────

/** Default (no --orchestrate) is the safe, read-only ["observe"] scope. */
export function mintScopesFor(orchestrate: boolean): string[] {
	return orchestrate ? [SCOPE_OBSERVE, SCOPE_MANAGE] : [SCOPE_OBSERVE];
}

export async function mintKey(
	client: AgentPulseClient,
	name: string,
	scopes: string[],
): Promise<CreateApiKeyResult> {
	return client.createApiKey(name, scopes);
}

// ─── Reused-key preflight (M12) ─────────────────────────────────────

/**
 * Reuses discoverScopes() (Phase 2/scopes.ts) wholesale for the shared
 * failure modes — unreachable/rejected key, a server predating the
 * `scopes` field on /auth/me, and a key holding neither observe nor
 * manage all throw the exact same ScopeDiscoveryError, with the exact same
 * message text, that `mcp serve` already produces (M12: "the same
 * min-version failure as serve"). This adds a BIDIRECTIONAL delta check on
 * top (F23 was one-directional; F22 — codex r2, post-Phase-5 diff review —
 * closes the gap it left open):
 *
 *   - --orchestrate requested but the key doesn't hold "manage" → refuse
 *     (unchanged from the original one-directional check).
 *   - the key DOES hold "manage" (or "*", which discoverScopes normalizes
 *     to hold manage) but --orchestrate was NOT passed → refuse. Without
 *     this, `--key <manage-capable key>` (no --orchestrate) would preflight
 *     successfully, `mcp serve` would later register every mutating tool
 *     for that same key (scope discovery is independent of how the key was
 *     installed), and the install output would have carried neither
 *     ORCHESTRATE_WARNING nor the Codex approval-mode line — a
 *     manage-capable server configured with zero safety framing. Requiring
 *     the explicit flag makes orchestration an acknowledged opt-in for
 *     EVERY path that can produce a manage-capable install, not just mint.
 *
 * Callers (runInstall) must derive canOrchestrate/warning from the scopes
 * this function RETURNS (i.e. `scopes.includes(SCOPE_MANAGE)`), not from
 * the caller's own --orchestrate flag — after a successful preflight the
 * two always agree (the mismatched cases are refused above), but deriving
 * from the actual discovered scopes is the property that's actually being
 * guaranteed, and is what tests should pin.
 */
export async function preflightReusedKey(
	client: AgentPulseClient,
	opts: { wantManage: boolean },
): Promise<string[]> {
	const scopes = await discoverScopes(client);
	const hasManage = scopes.includes(SCOPE_MANAGE);

	if (opts.wantManage && !hasManage) {
		throw new ScopeDiscoveryError(
			`This API key lacks "${SCOPE_MANAGE}" scope required for --orchestrate (it holds: ${scopes.join(", ")}). Mint an orchestration-capable key instead: agentpulse mcp install --mint <name> --orchestrate`,
		);
	}

	if (!opts.wantManage && hasManage) {
		throw new ScopeDiscoveryError(
			`This API key holds "${SCOPE_MANAGE}" scope (it can orchestrate). Re-run with --orchestrate to acknowledge the unattended-control implications, or use an observe-only key for a read-only install.`,
		);
	}

	return scopes;
}

// ─── CLI arg parsing ────────────────────────────────────────────────

export interface InstallArgs {
	url: string;
	/** Reuse an existing key. When both key and mint are given, mint wins
	 * (see runInstall) and key is used only to authenticate the mint call. */
	key?: string;
	/** Mint a new key with this name. */
	mint?: string;
	orchestrate: boolean;
}

export class InstallArgsError extends Error {}

const DEFAULT_INSTALL_URL = "http://localhost:3000";
const USAGE =
	"Usage: agentpulse mcp install (--key <existing key> | --mint <name>) [--url <url>] [--orchestrate]";

/**
 * --url is interpolated, unescaped, into both a shell command
 * (emitClaudeCommand) and a TOML string literal (emitCodexToml's
 * `env = { AGENTPULSE_URL = "<url>" }`). Validating here — at the single
 * ingestion point — closes both injection vectors at the source rather
 * than defending each emitter separately (xander Medium+Low, mid-build
 * review): a crafted --url containing `"` breaks out of the TOML string
 * and can splice in an arbitrary `[mcp_servers.evil]` block; one containing
 * shell metacharacters executes on paste from emitClaudeCommand's output.
 */
const DISALLOWED_URL_CHARS_RE = /["'`$;|\p{Cc}]/u;

function validateUrl(value: string): string {
	if (DISALLOWED_URL_CHARS_RE.test(value)) {
		throw new InstallArgsError(
			`--url contains a disallowed character (quote/backtick/shell metacharacter/control character): ${JSON.stringify(value)}. ${USAGE}`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new InstallArgsError(
			`--url is not a well-formed URL: ${JSON.stringify(value)}. ${USAGE}`,
		);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new InstallArgsError(
			`--url must use http:// or https:// (got "${parsed.protocol}"). ${USAGE}`,
		);
	}
	return value;
}

export function parseInstallArgs(args: string[]): InstallArgs {
	let url: string | undefined;
	let key: string | undefined;
	let mint: string | undefined;
	let orchestrate = false;

	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		switch (flag) {
			case "--url": {
				const value = args[++i];
				if (!value) throw new InstallArgsError(`--url requires a value. ${USAGE}`);
				url = validateUrl(value);
				break;
			}
			case "--key":
				key = args[++i];
				if (!key) throw new InstallArgsError(`--key requires a value. ${USAGE}`);
				break;
			case "--mint":
				mint = args[++i];
				if (!mint)
					throw new InstallArgsError(`--mint requires a value (the new key's name). ${USAGE}`);
				break;
			case "--orchestrate":
				orchestrate = true;
				break;
			default:
				throw new InstallArgsError(`Unknown flag: ${flag}. ${USAGE}`);
		}
	}

	if (!key && !mint) {
		throw new InstallArgsError(
			`agentpulse mcp install requires --key <existing key> (reuse) or --mint <name> (mint a new key). ${USAGE}`,
		);
	}

	return { url: url ?? DEFAULT_INSTALL_URL, key, mint, orchestrate };
}

// ─── Auth-key resolution ────────────────────────────────────────────

/**
 * Three-way credential resolution for the client that backs the
 * mint-or-preflight call: an explicit `--key` wins, else
 * `AGENTPULSE_API_KEY` from the environment (the same fallback `mcp serve`
 * uses), else empty (viable only under DISABLE_AUTH=true). Extracted as a
 * pure function so the actual precedence rule bin/cli.ts applies is
 * unit-tested here rather than only reachable end-to-end (tessa M-7).
 */
export function resolveAuthKey(parsedKey: string | undefined, envKey: string | undefined): string {
	return parsedKey ?? envKey ?? "";
}

// ─── Orchestration ──────────────────────────────────────────────────

export interface RunInstallResult {
	scopes: string[];
	keyRef: string;
	claudeCommand: string;
	mcpJson: string;
	codexToml: string;
	warning?: string;
}

/**
 * `client` must already be authenticated with whatever credential should
 * back the mint-or-preflight call (an existing `--key`, `AGENTPULSE_API_KEY`
 * from the environment, or none at all under DISABLE_AUTH) — bin/cli.ts
 * builds it. Mint takes precedence when both `args.key` and `args.mint` are
 * given: `args.key` is then used purely to authenticate the mint request,
 * and the freshly-minted key becomes the emitted keyRef (matching Settings'
 * own mint UI: shown once, on creation).
 *
 * canOrchestrate (which drives ORCHESTRATE_WARNING + the Codex
 * default_tools_approval_mode line) is derived differently per path (F22,
 * codex r2): on the MINT path it's `args.orchestrate` directly — mint
 * scope IS chosen by that flag (mintScopesFor), so they're the same value
 * by construction. On the REUSE path it's the key's ACTUAL discovered
 * scopes (`scopes.includes(SCOPE_MANAGE)`), not `args.orchestrate` — a
 * reused key's real capability can't be inferred from the flag alone, and
 * preflightReusedKey's bidirectional check (above) already guarantees the
 * two agree by the time we get here, so this is both the safe derivation
 * AND the one that matches what actually gets guaranteed.
 */
export async function runInstall(
	client: AgentPulseClient,
	args: InstallArgs,
): Promise<RunInstallResult> {
	if (!args.mint && !args.key) {
		throw new InstallArgsError(`runInstall requires args.key or args.mint. ${USAGE}`);
	}

	let keyRef: string;
	let scopes: string[];
	let canOrchestrate: boolean;

	if (args.mint) {
		scopes = mintScopesFor(args.orchestrate);
		const minted = await mintKey(client, args.mint, scopes);
		keyRef = minted.key;
		canOrchestrate = args.orchestrate;
	} else {
		scopes = await preflightReusedKey(client, { wantManage: args.orchestrate });
		keyRef = args.key as string;
		canOrchestrate = scopes.includes(SCOPE_MANAGE);
	}

	return {
		scopes,
		keyRef,
		claudeCommand: emitClaudeCommand({ url: args.url, keyRef }),
		mcpJson: emitMcpJson({ url: args.url, keyRef }),
		codexToml: emitCodexToml({ url: args.url, keyRef, canOrchestrate }),
		warning: canOrchestrate ? ORCHESTRATE_WARNING : undefined,
	};
}
