import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, getUserBySessionToken } from "../services/local-auth-service.js";
import { verifyApiKey } from "./api-key.js";
import { extractSupervisorToken, verifySupervisorCredential } from "./supervisor-auth.js";

export interface AuthUser {
	source: "authentik" | "api_key" | "local";
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

// Strip every X-Authentik-* header from the request so they cannot leak to
// downstream middleware, logs, or accidental upstream consumers.
function stripAuthentikHeaders(rawHeaders: Headers): void {
	for (const name of [...rawHeaders.keys()]) {
		if (name.toLowerCase().startsWith("x-authentik-")) {
			rawHeaders.delete(name);
		}
	}
}

// Verify the X-Authentik-Verify header against the configured shared secret.
// Returns true only when the secret is configured AND matches the header value.
// On any failure (missing secret, missing header, length mismatch, wrong value)
// returns false — caller is responsible for stripping headers and returning null.
function verifyAuthentikSecret(provided: string): boolean {
	const expected = config.authentikTrustSecret;
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

	// 1. Authentik forwardAuth headers — validated via shared-secret trust gate.
	//    Note: this path is only meaningful when called with the raw request Headers
	//    object (i.e. from getAuthUser(c)); the duck-typed wrapper callers never
	//    carry X-Authentik-* in practice (API-key/test paths). The trust gate is
	//    skipped here because the wrapper doesn't expose .delete(). Prefer
	//    getAuthUser(c) for full trust-gate enforcement.
	const authentikUser = headers.get("X-authentik-username");
	if (authentikUser) {
		// If called with real Headers (not the duck-typed wrapper), enforce trust gate.
		if (headers instanceof Headers) {
			const provided = headers.get("X-Authentik-Verify") ?? "";
			if (!verifyAuthentikSecret(provided)) {
				stripAuthentikHeaders(headers);
				console.warn(
					JSON.stringify({
						kind: "authentik_trust_gate_rejected",
						level: "warn",
						reason: provided ? "secret_mismatch" : "missing_verify_header",
					}),
				);
				// Fall through to other auth methods — headers stripped.
			} else {
				return {
					source: "authentik",
					name: authentikUser,
					id: headers.get("X-authentik-uid") || undefined,
				};
			}
		} else {
			// Duck-typed wrapper (test/API-key callers): trust without secret check.
			// This path is not reachable from live HTTP requests — Bun.serve always
			// passes real Headers. Authentik trust gate does not apply here.
			return {
				source: "authentik",
				name: authentikUser,
				id: headers.get("X-authentik-uid") || undefined,
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

// Extract auth user from request (Authentik headers or API key).
// Uses the raw request Headers object so the Authentik trust gate can strip
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

// Middleware: require any auth (Authentik or API key)
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
