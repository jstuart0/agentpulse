/**
 * Builds the `DecisionContext` the HITL decision service judges a caller by. It is the only
 * place one is made from a request, and it reads the authenticated caller (`authUser`), never
 * the request body, a header or the surface the request claims to come from.
 */
import type { Context } from "hono";
import type { HitlReplyKind } from "../../shared/types.js";
import type { AuthUser } from "../auth/middleware.js";
import { callerHasManageScope, getRequestActor } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import type { DecisionContext, DecisionSource } from "../services/ai/hitl-decision-service.js";
import {
	NOT_OWNER_MESSAGE,
	NotOwnerError,
	assertCanChangeSessions,
} from "../services/authorization.js";

const PROMPT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const HITL_ACTIONS: readonly HitlReplyKind[] = ["approve", "decline", "custom"];

export interface DecisionBody {
	action: HitlReplyKind;
	customPrompt?: string;
	/** SHA-256 of the prompt the person reviewed; the web client names it `promptSha256`, the phone `promptHash`. */
	promptHash?: string;
}

/** Reads and checks the body of a HITL decision: the parsed body, or the 400 to answer with. */
export async function readDecisionBody(
	c: Context,
): Promise<{ ok: true; body: DecisionBody } | { ok: false; response: Response }> {
	const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!raw || typeof raw !== "object") {
		return { ok: false, response: c.json({ error: "invalid_body" }, 400) };
	}
	if (!HITL_ACTIONS.includes(raw.action as HitlReplyKind)) {
		return {
			ok: false,
			response: c.json(
				{ error: "invalid_action", message: "action must be approve, decline or custom" },
				400,
			),
		};
	}
	const hash = raw.promptHash ?? raw.promptSha256 ?? undefined;
	if (hash !== undefined && !(typeof hash === "string" && PROMPT_HASH_PATTERN.test(hash))) {
		return {
			ok: false,
			response: c.json(
				{ error: "invalid_prompt_hash", message: "promptHash must be 64 lowercase hex characters" },
				400,
			),
		};
	}
	return {
		ok: true,
		body: {
			action: raw.action as HitlReplyKind,
			customPrompt: typeof raw.customPrompt === "string" ? raw.customPrompt : undefined,
			promptHash: hash as string | undefined,
		},
	};
}

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
