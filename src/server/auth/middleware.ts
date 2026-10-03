import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, resolveSessionByToken } from "../services/local-auth-service.js";
import { forwardauthSubject, resolveSsoUser } from "../services/user-identity.js";
import { SCOPE_ALL, SCOPE_INGEST, verifyApiKey } from "./api-key.js";
import { extractSupervisorToken, verifySupervisorCredential } from "./supervisor-auth.js";

export interface AuthUser {
	source: "forwardauth" | "api_key" | "local";
	/** The configured forwardauth provider label (e.g. "authentik", "authelia"). Only set when source === "forwardauth". */
	provider?: string;
	name: string;
	id?: string;
	role?: "user" | "admin";
	/**
	 * Capability set for api_key callers. Parsed from the DB record (trusted; never client-supplied).
	 * forwardauth and local callers omit this field — they pass requireScope() unconditionally.
	 * DISABLE_AUTH callers receive ["*"] so all gates open.
	 */
	scopes?: string[];
	/**
	 * users.id for local and SSO callers; the key's owner for api_key callers;
	 * null for service keys, DISABLE_AUTH, and supervisor credentials.
	 */
	userId: string | null;
	/**
	 * api_keys.id for real key callers; null for DISABLE_AUTH and supervisor
	 * credentials — their `id` is "anonymous" or a supervisor id, never a key.
	 */
	keyId: string | null;
	/**
	 * Set when the caller must change their password before any other access
	 * (requireAuth refuses them everywhere but the change itself). Reflects
	 * users.must_change_password for cookie and SSO callers and for a key's
	 * owner; false for a service key, DISABLE_AUTH and supervisor credentials.
	 */
	mustChangePassword: boolean;
	/**
	 * The CURRENT role of an api_key caller's owner, read with the key on every
	 * request (so demoting an admin takes admin power from their keys at once).
	 * Null for a service key or an owner with no row; absent for every other
	 * caller, whose own `role` says it.
	 */
	ownerRole?: "user" | "admin" | null;
	/**
	 * A display label for the caller, never the stored "sso:provider:subject"
	 * username. Set for SSO callers (from the username header, resolved once
	 * per request); null for every other source — callers fall back to
	 * `name` when this is null.
	 */
	displayName: string | null;
	/**
	 * True only for a verified supervisor credential (requireSupervisorAuth,
	 * non-DISABLE_AUTH path). Supervisor credentials carry `source: "api_key"`
	 * for scope-gating purposes (they're bearer-header auth, not a user
	 * session), but they are a distinct caller kind — `id` is a supervisor
	 * id, never a key, and there is no underlying api_keys row. actor.ts uses
	 * this to give them their own Actor label instead of folding into the
	 * generic "api_key" one. Omitted (falsy) for every other caller.
	 */
	isSupervisorCredential?: boolean;
}

/**
 * Hono context key the forwardauth bridge uses to hand its already-resolved
 * identity to the rest of the request, so a request that both carries
 * forwardauth headers and needs to mint or revoke a session cookie resolves
 * the user exactly once. Absent (not just falsy) means the bridge didn't
 * resolve for this request — the normal header/cookie resolution runs as
 * usual. Present with a `null` value means the bridge resolved and found no
 * usable identity (e.g. disabled) — skip re-resolving and treat as
 * unauthenticated.
 */
const FORWARDAUTH_RESOLVED_KEY = "forwardauthResolvedUser";

export function setForwardauthResolvedUser(c: Context, user: AuthUser | null): void {
	c.set(FORWARDAUTH_RESOLVED_KEY, user);
}

/**
 * Build the forwardauth AuthUser shape from an already-resolved SSO user.
 * Shared by the inline header path and the bridge, so both construct the
 * identity the same way. Returns null when the resolved row is disabled.
 */
export function buildForwardauthAuthUser(input: {
	forwardauthUsername: string;
	uid: string | undefined;
	provider: string;
	ssoUser: Awaited<ReturnType<typeof resolveSsoUser>>;
}): AuthUser | null {
	if (input.ssoUser.disabled) return null;
	return {
		source: "forwardauth",
		provider: input.provider,
		name: input.forwardauthUsername,
		id: input.uid,
		role: input.ssoUser.role,
		userId: input.ssoUser.id,
		keyId: null,
		mustChangePassword: input.ssoUser.mustChangePassword,
		displayName: input.ssoUser.displayName,
	};
}

function parseCookieHeader(cookieHeader: string | null, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const [rawKey, ...rest] = part.split("=");
		if (rawKey?.trim() === name) return decodeURIComponent(rest.join("=").trim());
	}
	return null;
}

// Strip every forwardauth identity header from the request so they cannot leak
// to downstream middleware, logs, or accidental upstream consumers. The prefix
// is configurable (default: "X-Authentik-") so any upstream IdP works without
// code changes. See config.forwardauthHeader("strip_prefix").
function stripForwardauthHeaders(rawHeaders: Headers): void {
	const prefix = config.forwardauthHeader("strip_prefix").toLowerCase();
	for (const name of [...rawHeaders.keys()]) {
		if (name.toLowerCase().startsWith(prefix)) {
			rawHeaders.delete(name);
		}
	}
}

// Verify the forwardauth verify header against the configured shared secret.
// Returns true only when the secret is configured AND matches the header value.
// On any failure (missing secret, missing header, length mismatch, wrong value)
// returns false — caller is responsible for stripping headers and returning null.
export function verifyForwardauthSecret(provided: string): boolean {
	const expected = config.forwardauthTrustSecret;
	if (!expected || !provided) return false;

	const expectedBuf = Buffer.from(expected);
	const providedBuf = Buffer.from(provided);

	// timingSafeEqual throws when buffer lengths differ — guard first.
	if (expectedBuf.length !== providedBuf.length) return false;

	return timingSafeEqual(expectedBuf, providedBuf);
}

export async function getAuthUserFromHeaders(headers: Headers): Promise<AuthUser | null> {
	if (config.disableAuth) {
		return {
			source: "api_key",
			name: "anonymous",
			id: "anonymous",
			scopes: [SCOPE_ALL],
			userId: null,
			keyId: null,
			mustChangePassword: false,
			displayName: null,
		};
	}

	// 1. Forwardauth identity headers — validated via shared-secret trust gate.
	//    Header names are configurable; defaults are Authentik-compatible (e.g.
	//    X-Authentik-Username) so any forwardauth IdP works via env config.
	const forwardauthUser = headers.get(config.forwardauthHeader("username"));
	if (forwardauthUser) {
		const provided = headers.get(config.forwardauthHeader("verify")) ?? "";
		if (!verifyForwardauthSecret(provided)) {
			stripForwardauthHeaders(headers);
			console.warn(
				JSON.stringify({
					kind: "forwardauth_trust_gate_rejected",
					level: "warn",
					reason: provided ? "secret_mismatch" : "missing_verify_header",
				}),
			);
			// Fall through to other auth methods — headers stripped.
		} else {
			// id stays the uid header value or undefined, as before. userId/role
			// resolve through the same (provider, subject) helper the bridge uses.
			const subjectInfo = forwardauthSubject(headers);
			if (!subjectInfo) {
				// Oversized subject (L-4) — no identity, same as the bridge's "no mint".
				return null;
			}
			const ssoUser = await resolveSsoUser({
				provider: config.forwardauthProvider,
				subject: subjectInfo.subject,
				source: subjectInfo.source,
				username: subjectInfo.username,
			});
			return buildForwardauthAuthUser({
				forwardauthUsername: forwardauthUser,
				uid: headers.get(config.forwardauthHeader("uid")) || undefined,
				provider: config.forwardauthProvider,
				ssoUser,
			});
		}
	}

	// 2. Bearer ap_* is authoritative — must be checked BEFORE the cookie
	//    (Decision 8, C-1 residual). The edge IngressRoute routes any request
	//    with a syntactic `Authorization: Bearer ap_*` header around the
	//    forwardauth catch-all. Without this guard, a stale/foreign `ap_session`
	//    cookie would authorize via step-3 below even when the API key is invalid.
	//    Fix: if the header is present it is the ONLY allowed credential for this
	//    request. Valid key → api_key identity; invalid/unknown key → reject (null).
	//    Browsers never send this header, so no legitimate flow is broken.
	//
	//    The old general `Bearer ` step (which ran after the cookie) is folded
	//    here: all valid keys are `ap_`-prefixed (api-key.ts:12,45), so there
	//    was no reachable case for non-`ap_` Bearers in the old code either.
	const authHeader = headers.get("Authorization");
	if (authHeader?.startsWith("Bearer ap_")) {
		const keyRecord = await verifyApiKey(authHeader.slice(7));
		return keyRecord
			? {
					source: "api_key",
					name: keyRecord.name,
					id: keyRecord.id,
					scopes: keyRecord.scopes,
					userId: keyRecord.ownerUserId,
					keyId: keyRecord.id,
					mustChangePassword: keyRecord.ownerMustChangePassword,
					ownerRole: keyRecord.ownerRole,
					displayName: null,
				}
			: null;
	}

	// 3. Session cookie (ap_session) — local or SSO-bridged (Phase 2).
	//    resolveSessionByToken returns a discriminated union so we can map
	//    local→source:"local" and SSO→source:"forwardauth" here at the boundary,
	//    keeping the session service free of the AuthUser type (no circular dep).
	const cookieHeader = headers.get("cookie") ?? headers.get("Cookie");
	const sessionToken = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);
	if (sessionToken) {
		const resolved = await resolveSessionByToken(sessionToken);
		if (resolved?.kind === "local") {
			return {
				source: "local",
				name: resolved.user.username,
				id: resolved.user.id,
				role: resolved.user.role,
				userId: resolved.user.id,
				keyId: null,
				mustChangePassword: resolved.user.mustChangePassword,
				displayName: null,
			};
		}
		if (resolved?.kind === "sso") {
			return {
				source: "forwardauth",
				provider: resolved.provider,
				name: resolved.username,
				id: resolved.subject,
				role: resolved.role,
				userId: resolved.userId,
				keyId: null,
				mustChangePassword: resolved.mustChangePassword,
				displayName: resolved.displayName,
			};
		}
	}

	return null;
}

// Extract auth user from request (forwardauth headers or API key).
//
// Checks the forwardauth bridge's resolved-identity context key first: when
// the bridge already resolved the caller this request (to decide whether to
// mint or revoke a session cookie), reuse that result instead of resolving
// again. The key is present (even as `null`, for a disabled user) only when
// the bridge actually performed a resolve — absent means the bridge didn't
// run or didn't need to, and the normal header/cookie resolution runs as
// usual. Uses the raw request Headers object for that fallback path so the
// forwardauth trust gate can strip forged headers via Headers.delete()
// before other middleware sees them.
export async function getAuthUser(c: Context): Promise<AuthUser | null> {
	if (c.get(FORWARDAUTH_RESOLVED_KEY) !== undefined) {
		return c.get(FORWARDAUTH_RESOLVED_KEY) as AuthUser | null;
	}
	return getAuthUserFromHeaders(c.req.raw.headers);
}

// Middleware: require API key auth (for hook endpoints).
// Enforces the `ingest` scope — a manage-only key cannot post hooks.
// Skipped entirely when DISABLE_AUTH=true.
export function requireApiKey() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", {
				source: "api_key",
				name: "anonymous",
				id: "anonymous",
				scopes: [SCOPE_ALL],
				userId: null,
				keyId: null,
				mustChangePassword: false,
				displayName: null,
			});
			return next();
		}

		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Missing API key" }, 401);
		}

		const token = authHeader.slice(7);
		const keyRecord = await verifyApiKey(token);
		if (!keyRecord) {
			return c.json({ error: "Invalid API key" }, 401);
		}

		// Enforce ingest scope at the hook boundary.
		// Sits before hookRateLimit's always-200 zone — see ingest.ts:112.
		if (!keyRecord.scopes.includes(SCOPE_ALL) && !keyRecord.scopes.includes(SCOPE_INGEST)) {
			return c.json({ error: "insufficient_scope", required: SCOPE_INGEST }, 403);
		}

		c.set("authUser", {
			source: "api_key",
			name: keyRecord.name,
			id: keyRecord.id,
			scopes: keyRecord.scopes,
			userId: keyRecord.ownerUserId,
			keyId: keyRecord.id,
			// Carried for the record; hook ingest is never gated on it.
			mustChangePassword: keyRecord.ownerMustChangePassword,
			ownerRole: keyRecord.ownerRole,
			displayName: null,
		});
		await next();
	};
}

/** Context key holding the identity requireAuth already resolved for this request. */
const REQUEST_AUTH_KEY = "requestAuthUser";

export interface RequireAuthOptions {
	/**
	 * Let a caller who must change their password through. Only the password
	 * change itself sets this; everything else refuses them.
	 */
	allowPasswordChangeRequired?: boolean;
}

/**
 * Resolves the caller once per request and hands back the same identity to
 * every later caller in that request. The bundle mounts requireAuth on every
 * router, and Hono runs each router's wildcard middleware for every request
 * that reaches a later router, so without this a cookie request to a late
 * router paid for the whole resolution once per router before it.
 */
async function resolveRequestAuthUser(c: Context): Promise<AuthUser | null> {
	const resolved = c.get(REQUEST_AUTH_KEY) as AuthUser | undefined;
	if (resolved) return resolved;
	const user = await getAuthUser(c);
	if (user) c.set(REQUEST_AUTH_KEY, user);
	return user;
}

/**
 * Authenticates the request and leaves the identity on the context, or returns
 * the response that refuses it: 401 when nobody is signed in, 403
 * password_change_required for a caller who must change their password first
 * (unless the route opts out). DISABLE_AUTH makes every request the anonymous
 * operator. Resolves once per request; see resolveRequestAuthUser.
 */
export async function authenticate(
	c: Context,
	options: RequireAuthOptions = {},
): Promise<Response | null> {
	if (config.disableAuth) {
		c.set("authUser", {
			source: "api_key",
			name: "anonymous",
			id: "anonymous",
			scopes: [SCOPE_ALL],
			userId: null,
			keyId: null,
			mustChangePassword: false,
			displayName: null,
		});
		return null;
	}

	const user = await resolveRequestAuthUser(c);
	if (!user) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	if (user.mustChangePassword && !options.allowPasswordChangeRequired) {
		return c.json({ error: "password_change_required" }, 403);
	}
	c.set("authUser", user);
	return null;
}

// Middleware: require any auth (forwardauth, local, or API key)
// Skipped entirely when DISABLE_AUTH=true.
//
// A caller who must change their password (a cookie or SSO user, or a key
// owned by one) gets 403 password_change_required on every route behind this
// middleware except where the route opts out. The auth router (/auth/me,
// login, logout) is mounted outside the bundle and never passes through here;
// hook ingest uses requireApiKey and is not gated.
export function requireAuth(options: RequireAuthOptions = {}) {
	return async (c: Context, next: Next) => {
		const refusal = await authenticate(c, options);
		if (refusal) return refusal;
		await next();
	};
}

/**
 * Middleware: require a specific scope on API key callers.
 * - DISABLE_AUTH=true → always passes.
 * - forwardauth / local session callers → always pass (scoping only applies to api_key tokens).
 * - api_key callers → pass when scopes includes the required scope or SCOPE_ALL ("*").
 *   Otherwise: 403 { error: "insufficient_scope", required: scope }.
 *
 * Must be chained AFTER requireAuth() so authUser is already set in context.
 */
export function requireScope(scope: string) {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			return next();
		}

		const authUser = c.get("authUser") as AuthUser | undefined;
		if (!authUser) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		// Non-api_key callers (forwardauth / local) are never scope-limited.
		if (authUser.source !== "api_key") {
			return next();
		}

		const scopes = authUser.scopes ?? [];
		if (scopes.includes(SCOPE_ALL) || scopes.includes(scope)) {
			return next();
		}

		return c.json({ error: "insufficient_scope", required: scope }, 403);
	};
}

export function requireSupervisorAuth() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", {
				source: "api_key",
				name: "anonymous",
				id: "anonymous",
				scopes: [SCOPE_ALL],
				userId: null,
				keyId: null,
				mustChangePassword: false,
				displayName: null,
			});
			return next();
		}

		const token = extractSupervisorToken({
			get: (name: string) => c.req.header(name) ?? null,
		});
		if (!token) {
			return c.json({ error: "Missing supervisor credential" }, 401);
		}

		const credential = await verifySupervisorCredential(token);
		if (!credential) {
			return c.json({ error: "Invalid supervisor credential" }, 401);
		}

		const routeSupervisorId = c.req.param("id");
		if (routeSupervisorId && credential.supervisorId !== routeSupervisorId) {
			return c.json({ error: "Supervisor credential does not match target supervisor" }, 403);
		}

		// Supervisor credentials are never a user or a key — a supervisor id
		// is neither.
		c.set("authUser", {
			source: "api_key",
			name: credential.name,
			id: credential.supervisorId,
			userId: null,
			keyId: null,
			mustChangePassword: false,
			displayName: null,
			isSupervisorCredential: true,
		});
		await next();
	};
}
