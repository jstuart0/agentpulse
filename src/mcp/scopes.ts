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
import packageJson from "../../package.json" with { type: "json" };
import { SCOPE_ALL, SCOPE_MANAGE, SCOPE_OBSERVE } from "../server/auth/api-key.js";
import type { AgentPulseClient } from "./client.js";

export class ScopeDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScopeDiscoveryError";
	}
}

const MINT_HINT =
	'Mint a scoped key in AgentPulse Settings > API Keys (or POST /api/v1/api-keys with {"name":"mcp","scopes":["observe"]}).';

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
			`This AgentPulse instance does not report API key scopes on /auth/me. AgentPulse >= ${packageJson.version} is required for MCP. Upgrade the server.`,
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
