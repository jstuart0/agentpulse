import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, resolveSessionByToken } from "../services/local-auth-service.js";
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
		return { source: "api_key", name: "anonymous", id: "anonymous", scopes: [SCOPE_ALL] };
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
			return {
				source: "forwardauth",
				provider: config.forwardauthProvider,
				name: forwardauthUser,
				id: headers.get(config.forwardauthHeader("uid")) || undefined,
			};
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
			? { source: "api_key", name: keyRecord.name, id: keyRecord.id, scopes: keyRecord.scopes }
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
			};
		}
		if (resolved?.kind === "sso") {
			return {
				source: "forwardauth",
				provider: resolved.provider,
				name: resolved.username,
				id: resolved.subject,
			};
		}
	}

	return null;
}

// Extract auth user from request (forwardauth headers or API key).
// Uses the raw request Headers object so the forwardauth trust gate can strip
// forged headers via Headers.delete() before other middleware sees them.
export async function getAuthUser(c: Context): Promise<AuthUser | null> {
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
		});
		await next();
	};
}

// Middleware: require any auth (forwardauth, local, or API key)
// Skipped entirely when DISABLE_AUTH=true
export function requireAuth() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", {
				source: "api_key",
				name: "anonymous",
				id: "anonymous",
				scopes: [SCOPE_ALL],
			});
			return next();
		}

		const user = await getAuthUser(c);
		if (!user) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		c.set("authUser", user);
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

		c.set("authUser", { source: "api_key", name: credential.name, id: credential.supervisorId });
		await next();
	};
}
