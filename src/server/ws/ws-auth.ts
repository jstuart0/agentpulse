/**
 * WebSocket upgrade auth + scope guard.
 *
 * Extracted from the Bun.serve fetch handler so it can be unit-tested
 * independently of the full server boot sequence. Returns null when the
 * caller is allowed to proceed to upgrade; returns a Response when the
 * request must be rejected.
 *
 * Rules:
 *  - No authUser (unauthenticated) → 401
 *  - authUser.source === "api_key" && scopes lacks "manage" or "*" → 403
 *  - forwardauth/local → pass (humans always have full access)
 *  - disableAuth → pass (scope enforcement bypassed)
 */
import { SCOPE_ALL, SCOPE_MANAGE } from "../auth/api-key.js";
import { getAuthUserFromHeaders } from "../auth/middleware.js";
import { config } from "../config.js";

export async function guardWsUpgrade(headers: Headers): Promise<Response | null> {
	if (config.disableAuth) {
		return null; // all requests allowed; scope enforcement is bypassed
	}

	const authUser = await getAuthUserFromHeaders(headers);
	if (!authUser) {
		return new Response("Unauthorized", { status: 401 });
	}

	if (authUser.source === "api_key") {
		const scopes: string[] = authUser.scopes ?? [];
		if (!scopes.includes(SCOPE_MANAGE) && !scopes.includes(SCOPE_ALL)) {
			return new Response(JSON.stringify({ error: "insufficient_scope", required: SCOPE_MANAGE }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	return null; // allowed
}
