/**
 * Builds the `DecisionContext` the HITL decision service judges a caller by. It is the only
 * place one is made from a request, and it reads the authenticated caller (`authUser`), never
 * the request body, a header or the surface the request claims to come from.
 */
import type { Context } from "hono";
import type { AuthUser } from "../auth/middleware.js";
import { callerHasManageScope, getRequestActor } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import type { DecisionContext, DecisionSource } from "../services/ai/hitl-decision-service.js";
import {
	NOT_OWNER_MESSAGE,
	NotOwnerError,
	assertCanChangeSessions,
} from "../services/authorization.js";

function sourceOf(authUser: AuthUser | undefined): DecisionSource {
	// Auth switched off: nobody is signed in, and the person at the keyboard is the operator, as a person.
	if (!authUser) return "session";
	if (authUser.source === "forwardauth") return "sso";
	if (authUser?.source === "local") return "session";
	return "api_key";
}

export async function decisionContextFor(c: Context): Promise<DecisionContext> {
	const authUser = c.get("authUser") as AuthUser | undefined;
	return {
		actor: await getRequestActor(c),
		source: sourceOf(authUser),
		keyId: authUser?.source === "api_key" ? authUser.keyId : null,
		scopes: authUser?.scopes ?? [],
		// With auth off there is no caller to judge: the operator may write prompts.
		canCustomPrompt: authUser ? callerHasManageScope(authUser) : config.disableAuth,
	};
}

/** The same owner check as a yes or no, for a response that leaves a field out rather than refusing. */
export async function mayChangeSession(c: Context, sessionId: string): Promise<boolean> {
	try {
		await assertCanChangeSessions(await getRequestActor(c), [sessionId]);
		return true;
	} catch (err) {
		if (err instanceof NotOwnerError) return false;
		throw err;
	}
}

/**
 * The owner check for a route that changes a session: null to carry on, or the 403 `not_owner`
 * to answer with. In team mode only the session's owner, an admin, or (for an unowned session) an
 * identified member passes; solo never refuses.
 */
export async function refuseUnlessMayChange(
	c: Context,
	sessionId: string,
): Promise<Response | null> {
	try {
		await assertCanChangeSessions(await getRequestActor(c), [sessionId]);
		return null;
	} catch (err) {
		if (err instanceof NotOwnerError) {
			return c.json({ error: "not_owner", message: NOT_OWNER_MESSAGE }, 403);
		}
		throw err;
	}
}
