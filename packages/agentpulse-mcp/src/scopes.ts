/**
 * Startup scope discovery (AGEN-12 Phase 2, D5 — corrected per test-contract
 * Correction #2).
 *
 * DISABLE_AUTH=true does NOT make /auth/me return authenticated:false.
 * getAuthUserFromHeaders returns a synthetic {source:"api_key",
 * name:"anonymous", scopes:["*"]} user in that mode (middleware.ts:63-64),
 * so /auth/me reports authenticated:true. This module branches on
 * user.scopes.includes("*"), never on `authenticated`, per that correction.
 *
 * Fail-fast beats an empty tool list — MCP clients surface spawn errors
 * clearly; a silently-empty tool set would look like a broken server.
 */
import type { AgentPulseClient } from "./client.js";
import { ToolInputError } from "./errors.js";
import { SCOPE_ALL, SCOPE_MANAGE, SCOPE_OBSERVE } from "./scope-constants.js";
import type { OwnerScopeEcho } from "./types.js";

export class ScopeDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScopeDiscoveryError";
	}
}

const MINT_HINT =
	'Mint a scoped key in AgentPulse Settings > API Keys (or POST /api/v1/api-keys with {"name":"mcp","scopes":["observe"]}).';

/**
 * Human-readable minimum-server-version claim, NOT the enforcement — the
 * enforcement is the `scopes` field's actual presence on /auth/me, checked
 * below. The `/auth/me` response only started reporting API-key scopes
 * AFTER the v0.5.0 AgentPulse release (in the MCP-server campaign commits
 * that shipped this package's predecessor), so this package requires
 * AgentPulse's `main` branch / the future 0.6.0 release. Bump this string
 * whenever a later AgentPulse release becomes the actual functional floor
 * for a *different* reason — it is documentation for the upgrade-hint
 * message, not a version gate this module checks against.
 */
const MIN_SERVER_VERSION = "0.6.0";

/**
 * Calls /auth/me with the configured API key and returns the scopes the
 * MCP server should register tools for. Throws ScopeDiscoveryError on any
 * condition that should abort startup rather than silently register a
 * degraded (empty or wrong) tool set.
 */
export async function discoverScopes(client: AgentPulseClient): Promise<string[]> {
	const me = await client.getAuthMe();

	if (!me.authenticated || !me.user) {
		throw new ScopeDiscoveryError(
			`AgentPulse rejected the configured API key at ${client.baseUrl} (authenticated: false). Check AGENTPULSE_API_KEY and AGENTPULSE_URL.`,
		);
	}

	if (me.user.source !== "api_key") {
		// The MCP server always authenticates via API key — this branch
		// should be unreachable, but a stray forwardauth/local identity
		// (e.g. a misconfigured proxy) must fail fast, not silently default
		// to full or zero access.
		throw new ScopeDiscoveryError(
			`AgentPulse /auth/me resolved a non-API-key identity (source: "${me.user.source}") for the MCP server's Bearer token. This should be unreachable — check that AGENTPULSE_API_KEY is a valid ap_ key.`,
		);
	}

	const scopes = me.user.scopes;
	if (!scopes) {
		throw new ScopeDiscoveryError(
			`This AgentPulse instance does not report API key scopes on /auth/me. AgentPulse >= ${MIN_SERVER_VERSION} is required for MCP. Upgrade the server.`,
		);
	}

	if (scopes.includes(SCOPE_ALL)) {
		return [SCOPE_OBSERVE, SCOPE_MANAGE];
	}

	const held = scopes.filter((scope) => scope === SCOPE_OBSERVE || scope === SCOPE_MANAGE);
	if (held.length === 0) {
		throw new ScopeDiscoveryError(
			`This API key holds neither "${SCOPE_OBSERVE}" nor "${SCOPE_MANAGE}" scope — it cannot drive any MCP tool. ${MINT_HINT}`,
		);
	}

	return held;
}

/** Does the scope the server echoed back say it applied what was asked for? */
function echoConfirms(requested: string, echo: OwnerScopeEcho | undefined): boolean {
	if (echo === undefined) return false;
	switch (requested) {
		case "me":
			return echo.kind === "me" && typeof echo.userId === "string" && echo.userId !== "";
		case "unassigned":
		case "service":
			return echo.kind === requested;
		default:
			// A user id. The server lowercases ids; an uppercase request still means the same user.
			return echo.kind === "user" && echo.userId?.toLowerCase() === requested.toLowerCase();
	}
}

/**
 * Refuses a response that doesn't confirm the owner scope the caller asked for.
 * A server that predates owner scoping ignores the `owner` query parameter and
 * answers with everyone's results, which would read as the caller's own; the
 * only reliable tell is the response itself, which a current server tags with
 * the scope it applied (`ownerScope`). So when a scope was asked for the
 * response must echo exactly that scope, and anything else is an explicit error
 * rather than an unfiltered list. Nothing is required for `all` or no owner —
 * everyone's results are what an older server returns, and what was asked for.
 */
export function assertOwnerScopeEchoed(
	requested: string | undefined,
	echo: OwnerScopeEcho | undefined,
): void {
	if (requested === undefined || requested === "all") return;
	if (echoConfirms(requested, echo)) return;
	throw new ToolInputError(
		`This AgentPulse server did not confirm that it applied the owner scope "${requested}" (it may predate owner scoping and ignore "owner", or it applied a different scope), so these results could be everyone's. Upgrade the server, or leave owner unset. For "me" the key must belong to a user.`,
	);
}
