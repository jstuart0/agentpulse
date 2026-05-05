import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, getUserBySessionToken } from "../services/local-auth-service.js";
import { verifyApiKey } from "./api-key.js";
import { extractSupervisorToken, verifySupervisorCredential } from "./supervisor-auth.js";

export interface AuthUser {
	source: "forwardauth" | "api_key" | "local";
	/** The configured forwardauth provider label (e.g. "authentik", "authelia"). Only set when source === "forwardauth". */
	provider?: string;
	name: string;
	id?: string;
	role?: "user" | "admin";
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
function verifyForwardauthSecret(provided: string): boolean {
	const expected = config.forwardauthTrustSecret;
	if (!expected || !provided) return false;

	const expectedBuf = Buffer.from(expected);
	const providedBuf = Buffer.from(provided);

	// timingSafeEqual throws when buffer lengths differ — guard first.
	if (expectedBuf.length !== providedBuf.length) return false;

	return timingSafeEqual(expectedBuf, providedBuf);
}

export async function getAuthUserFromHeaders(
	headers: Headers | { get(name: string): string | null },
): Promise<AuthUser | null> {
	if (config.disableAuth) {
		return { source: "api_key", name: "anonymous", id: "anonymous" };
	}

	// 1. Forwardauth identity headers — validated via shared-secret trust gate.
	//    Header names are configurable; defaults are Authentik-compatible (e.g.
	//    X-Authentik-Username) so any forwardauth IdP works via env config.
	//    Note: the trust gate is only enforced when called with real Headers
	//    (i.e. from getAuthUser(c)); duck-typed wrapper callers never carry
	//    forwardauth headers in practice. Prefer getAuthUser(c) for full enforcement.
	const forwardauthUser = headers.get(config.forwardauthHeader("username"));
	if (forwardauthUser) {
		// If called with real Headers (not the duck-typed wrapper), enforce trust gate.
		if (headers instanceof Headers) {
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
		} else {
			// Duck-typed wrapper (test/API-key callers): trust without secret check.
			// This path is not reachable from live HTTP requests — Bun.serve always
			// passes real Headers. Forwardauth trust gate does not apply here.
			return {
				source: "forwardauth",
				provider: config.forwardauthProvider,
				name: forwardauthUser,
				id: headers.get(config.forwardauthHeader("uid")) || undefined,
			};
		}
	}

	// 2. Local session cookie (ap_session).
	const cookieHeader = headers.get("cookie") ?? headers.get("Cookie");
	const sessionToken = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);
	if (sessionToken) {
		const user = await getUserBySessionToken(sessionToken);
		if (user) {
			return {
				source: "local",
				name: user.username,
				id: user.id,
				role: user.role,
			};
		}
	}

	// 3. API key bearer (hook ingest + programmatic clients).
	const authHeader = headers.get("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		const keyRecord = await verifyApiKey(token);
		if (keyRecord) {
			return {
				source: "api_key",
				name: keyRecord.name,
				id: keyRecord.id,
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

// Middleware: require API key auth (for hook endpoints)
// Skipped entirely when DISABLE_AUTH=true
export function requireApiKey() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", { source: "api_key", name: "anonymous", id: "anonymous" });
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

		c.set("authUser", { source: "api_key", name: keyRecord.name, id: keyRecord.id });
		await next();
	};
}

// Middleware: require any auth (forwardauth, local, or API key)
// Skipped entirely when DISABLE_AUTH=true
export function requireAuth() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", { source: "api_key", name: "anonymous", id: "anonymous" });
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

export function requireSupervisorAuth() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			c.set("authUser", { source: "api_key", name: "anonymous", id: "anonymous" });
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
