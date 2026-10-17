/**
 * WebSocket upgrade auth + scope guard.
 *
 * Extracted from the Bun.serve fetch handler so it can be unit-tested
 * independently of the full server boot sequence. Returns either the
 * identity the socket will carry (user id, key id, scopes and profile; the ids
 * may be null) or the Response that rejects the request.
 *
 * Rules:
 *  - No authUser (unauthenticated) → 401
 *  - authUser.source === "api_key" and scopes hold neither "manage", "*" nor a
 *    scope whose SCOPE_GRANTS entry has `ws` (today: "respond") → 403
 *  - a disabled user (or a key owned by one) → 401
 *  - a user who must change their password (or a key owned by one) → 403 password_change_required
 *  - forwardauth/local → pass (humans always have full access)
 *  - disableAuth → pass, no identity (scope enforcement bypassed)
 *  - no Origin header: only a valid `Authorization: Bearer ap_` key outside
 *    disableAuth passes (a browser always sends Origin; a native client sends a
 *    bearer key and no Origin). A cookie or forwardauth identity with no Origin,
 *    and any socket with auth off, is refused.
 *  - after the upgrade the server may close a socket: 4001 means the credential
 *    is no longer valid (revoked, deleted, user disabled or password-gated: the
 *    client must re-pair or sign in); 4003 means it is still valid but its
 *    authority changed (instance mode switched, key handed to another owner: the
 *    client reconnects); 1011 means the server could not decide (reconnect). The
 *    constants live in ws/handler.ts.
 *  - a key already holding WS_MAX_SOCKETS_PER_KEY (8) open sockets is refused
 *    with 429 until one closes.
 *  - the mobile profile is forced for a key without manage/`*` and opt-in
 *    (`?profile=mobile`) for everyone else.
 */
import { SCOPE_ALL } from "../auth/api-key.js";
import { type AuthUser, getAuthUserFromHeaders } from "../auth/middleware.js";
import { isAcceptedSocketOrigin } from "../auth/request-origin.js";
import { SCOPE_GRANTS, scopesIncludeManage } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { WS_MAX_SOCKETS_PER_KEY, openSocketCountForKey } from "./handler.js";

/** The paths a WebSocket upgrade can arrive on (directly, and through the app-api prefix). */
export const WS_UPGRADE_PATHS: ReadonlySet<string> = new Set(["/api/v1/ws", "/app-api/v1/ws"]);

export type WsProfile = "web" | "mobile";

/** What an open socket remembers about whoever opened it. */
export interface WsConnectionData {
	userId: string | null;
	keyId: string | null;
	/** The key's scopes; a human (or auth off) carries the wildcard. */
	scopes: readonly string[];
	profile: WsProfile;
}

export type WsUpgradeDecision =
	| { allowed: true; data: WsConnectionData }
	| { allowed: false; response: Response };

export interface WsUpgradeOptions {
	/** The `profile` query parameter, if any. */
	requestedProfile?: string | null;
	/** False when the upgrade request carried no Origin header. Defaults to true. */
	originPresent?: boolean;
}

const FULL_ACCESS: readonly string[] = [SCOPE_ALL];

function reject(response: Response): WsUpgradeDecision {
	return { allowed: false, response };
}

function forbidden(): WsUpgradeDecision {
	return reject(new Response("Forbidden", { status: 403 }));
}

/** A restricted socket (no manage) is always mobile; anyone else is mobile only by asking. */
function profileFor(scopes: readonly string[], requested: string | null | undefined): WsProfile {
	if (!scopesIncludeManage(scopes)) return "mobile";
	return requested === "mobile" ? "mobile" : "web";
}

function socketMayConnect(scopes: readonly string[]): boolean {
	if (scopesIncludeManage(scopes)) return true;
	return scopes.some(
		(scope) => scope in SCOPE_GRANTS && SCOPE_GRANTS[scope as keyof typeof SCOPE_GRANTS].ws,
	);
}

export async function guardWsUpgrade(
	headers: Headers,
	options: WsUpgradeOptions = {},
): Promise<WsUpgradeDecision> {
	const originPresent = options.originPresent ?? true;

	if (config.disableAuth) {
		if (!originPresent) return forbidden();
		// all requests allowed; scope enforcement is bypassed
		return {
			allowed: true,
			data: {
				userId: null,
				keyId: null,
				scopes: FULL_ACCESS,
				profile: profileFor(FULL_ACCESS, options.requestedProfile),
			},
		};
	}

	const authUser = await getAuthUserFromHeaders(headers);
	if (!originPresent) {
		const bearerKey =
			authUser?.source === "api_key" && headers.get("Authorization")?.startsWith("Bearer ap_");
		if (!bearerKey) return forbidden();
	}
	if (!authUser) {
		return reject(new Response("Unauthorized", { status: 401 }));
	}

	let scopes: readonly string[] = FULL_ACCESS;
	if (authUser.source === "api_key") {
		scopes = authUser.scopes ?? [];
		if (!socketMayConnect(scopes)) {
			return reject(
				new Response(JSON.stringify({ error: "insufficient_scope", required: "manage" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
	}

	const refusal = refuseGatedUser(authUser);
	if (refusal) return reject(refusal);

	if (authUser.keyId && openSocketCountForKey(authUser.keyId) >= WS_MAX_SOCKETS_PER_KEY) {
		return reject(new Response("Too many connections for this key", { status: 429 }));
	}

	return {
		allowed: true,
		data: {
			userId: authUser.userId,
			keyId: authUser.keyId,
			scopes,
			profile: profileFor(scopes, options.requestedProfile),
		},
	};
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
	// only for a loopback or allowlisted Host (see isAcceptedSocketOrigin). The
	// literal "null", no Host and foreign origins are refused. A request with no
	// Origin at all is judged by guardWsUpgrade: only a Bearer `ap_` key passes.
	const origin = req.headers.get("Origin");
	if (origin && !isAcceptedSocketOrigin(origin, req.headers.get("Host") ?? undefined)) {
		return new Response("Forbidden", { status: 403 });
	}

	const decision = await guardWsUpgrade(req.headers, {
		originPresent: Boolean(origin),
		requestedProfile: new URL(req.url).searchParams.get("profile"),
	});
	if (!decision.allowed) return decision.response;
	if (server.upgrade(req, { data: decision.data })) return undefined;
	return new Response("WebSocket upgrade failed", { status: 400 });
}
