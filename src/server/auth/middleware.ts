import type { Context, Next } from "hono";
import { verifyApiKey } from "./api-key.js";
import { extractSupervisorToken, verifySupervisorCredential } from "./supervisor-auth.js";
import { config } from "../config.js";

export interface AuthUser {
	source: "authentik" | "api_key";
	name: string;
	id?: string;
}

// Extract auth user from request (Authentik headers or API key)
export async function getAuthUser(c: Context): Promise<AuthUser | null> {
	// Check 1: Authentik forwardAuth headers (set by Traefik)
	const authentikUser = c.req.header("X-authentik-username");
	if (authentikUser) {
		return {
			source: "authentik",
			name: authentikUser,
			id: c.req.header("X-authentik-uid") || undefined,
		};
	}

	// Check 2: Bearer token (API key)
	const authHeader = c.req.header("Authorization");
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
