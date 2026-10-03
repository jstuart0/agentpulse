/**
 * WebSocket upgrade auth + scope guard.
 *
 * Extracted from the Bun.serve fetch handler so it can be unit-tested
 * independently of the full server boot sequence. Returns either the
 * identity the socket will carry (user id and key id, either may be null)
 * or the Response that rejects the request.
 *
 * Rules:
 *  - No authUser (unauthenticated) → 401
 *  - authUser.source === "api_key" && scopes lacks "manage" or "*" → 403
 *  - a disabled user (or a key owned by one) → 401
 *  - a user who must change their password (or a key owned by one) → 403 password_change_required
 *  - forwardauth/local → pass (humans always have full access)
 *  - disableAuth → pass, no identity (scope enforcement bypassed)
 */
import { SCOPE_ALL, SCOPE_MANAGE } from "../auth/api-key.js";
import { type AuthUser, getAuthUserFromHeaders } from "../auth/middleware.js";
import { isAcceptedSocketOrigin } from "../auth/request-origin.js";
import { config } from "../config.js";

/** What an open socket remembers about whoever opened it. */
export interface WsConnectionData {
	userId: string | null;
	keyId: string | null;
}

export type WsUpgradeDecision =
	| { allowed: true; data: WsConnectionData }
	| { allowed: false; response: Response };

const ANONYMOUS: WsConnectionData = { userId: null, keyId: null };

function reject(response: Response): WsUpgradeDecision {
	return { allowed: false, response };
}

export async function guardWsUpgrade(headers: Headers): Promise<WsUpgradeDecision> {
	if (config.disableAuth) {
		return { allowed: true, data: ANONYMOUS }; // all requests allowed; scope enforcement is bypassed
	}

	const authUser = await getAuthUserFromHeaders(headers);
	if (!authUser) {
		return reject(new Response("Unauthorized", { status: 401 }));
	}

	if (authUser.source === "api_key") {
		const scopes: string[] = authUser.scopes ?? [];
		if (!scopes.includes(SCOPE_MANAGE) && !scopes.includes(SCOPE_ALL)) {
			return reject(
				new Response(JSON.stringify({ error: "insufficient_scope", required: SCOPE_MANAGE }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
	}

	const refusal = refuseGatedUser(authUser);
	if (refusal) return reject(refusal);

	return { allowed: true, data: { userId: authUser.userId, keyId: authUser.keyId } };
}

/**
 * A user who must change their password first holds no socket. The identity
 * carries the flag for cookie, SSO and key callers alike (a key's owner state
 * rides on the key lookup, which also refuses a disabled owner).
 */
function refuseGatedUser(authUser: AuthUser): Response | null {
	if (!authUser.mustChangePassword) return null;
	return new Response(JSON.stringify({ error: "password_change_required" }), {
		status: 403,
		headers: { "Content-Type": "application/json" },
	});
}

interface UpgradingServer {
	upgrade(req: Request, options?: { data?: unknown }): boolean;
}

/**
 * The whole WebSocket upgrade request: strict Origin check, auth/scope
 * guard, then the upgrade itself. Returns undefined on a successful
 * upgrade (the server owns the response from there) and a Response
 * otherwise. Extracted from the Bun.serve fetch handler so a test can drive
 * the real path against a real server.
 */
export async function handleWsUpgradeRequest(
	req: Request,
	server: UpgradingServer,
): Promise<Response | undefined> {
	// Strict Origin check — no NODE_ENV branching. An Origin is accepted when it
	// is on the allowlist derived from PUBLIC_URL (comma-separated; dev setups:
	// PUBLIC_URL=https://prod.example.com,http://localhost:5173) or is the
	// request's own (its host and port equal the Host header) — with auth off,
	// only for a loopback or allowlisted Host (see isAcceptedSocketOrigin). No
	// Origin, no Host, the literal "null" and foreign origins are refused.
	const origin = req.headers.get("Origin");
	if (!origin || !isAcceptedSocketOrigin(origin, req.headers.get("Host") ?? undefined)) {
		return new Response("Forbidden", { status: 403 });
	}

	const decision = await guardWsUpgrade(req.headers);
	if (!decision.allowed) return decision.response;
	if (server.upgrade(req, { data: decision.data })) return undefined;
	return new Response("WebSocket upgrade failed", { status: 400 });
}
