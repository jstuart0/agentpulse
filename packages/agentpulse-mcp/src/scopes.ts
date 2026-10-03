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
import { HOST_PARAM_MAX_LENGTH, UNKNOWN_HOST_PARAM } from "./enums.js";
import { ToolInputError } from "./errors.js";
import { SCOPE_ALL, SCOPE_MANAGE, SCOPE_OBSERVE } from "./scope-constants.js";
import type { HostFilterEcho, OwnerScopeEcho } from "./types.js";

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

/** Any character a stored machine name can never hold (control, format, line and paragraph separators, surrogates). */
const UNSAFE_HOST_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * The `host` query value for a tool call: undefined for every machine, the
 * reserved token for `no_host`, otherwise the trimmed machine name. Throws a
 * tool-input error for a name outside the grammar (too long, or holding control
 * characters) and for a name together with `no_host`, so nothing is requested
 * with a value the server would answer differently than the caller meant.
 */
export function resolveHostFilter(args: { host?: string; no_host?: boolean }): string | undefined {
	const named = args.host !== undefined && args.host.trim() !== "";
	if (args.no_host) {
		if (named) throw new ToolInputError("Use either host or no_host, not both.");
		return UNKNOWN_HOST_PARAM;
	}
	if (args.host === undefined) return undefined;
	if (args.host === UNKNOWN_HOST_PARAM) return UNKNOWN_HOST_PARAM;
	if (args.host.length > HOST_PARAM_MAX_LENGTH || UNSAFE_HOST_CHARACTERS.test(args.host)) {
		throw new ToolInputError(
			`host must be a machine name of at most ${HOST_PARAM_MAX_LENGTH} characters with no control characters.`,
		);
	}
	return named ? args.host.trim() : undefined;
}

/**
 * Refuses a response that doesn't confirm the machine filter the caller asked
 * for. A server that predates the filter ignores `host` and answers with every
 * machine's sessions, which would read as one machine's; the only reliable tell
 * is the response, which a current server tags with the filter it applied
 * (`hostFilter`). So when a machine was asked for the response must echo exactly
 * that, and a response that claims a filter nobody asked for is refused too.
 * With no machine asked for, an older server's silence is what was wanted.
 */
export function assertHostFilterEchoed(
	requested: string | undefined,
	echo: HostFilterEcho | undefined,
): void {
	const wanted: HostFilterEcho =
		requested === undefined
			? { kind: "all" }
			: requested === UNKNOWN_HOST_PARAM
				? { kind: "unknown" }
				: { kind: "host", host: requested };
	if (echo === undefined && wanted.kind === "all") return;
	if (
		typeof echo === "object" &&
		echo !== null &&
		echo.kind === wanted.kind &&
		(wanted.kind !== "host" || (echo as { host?: unknown }).host === wanted.host)
	) {
		return;
	}
	throw new ToolInputError(
		requested === undefined
			? "This AgentPulse server answered for a machine filter that was not asked for, so these results are not trustworthy as everyone's. Retry, or upgrade the server."
			: `This AgentPulse server did not confirm that it applied the host filter (${requested === UNKNOWN_HOST_PARAM ? "no machine" : `"${requested}"`}); it may predate the machine filter and ignore "host", so these results could be every machine's. Upgrade the server, or leave host unset.`,
	);
}
