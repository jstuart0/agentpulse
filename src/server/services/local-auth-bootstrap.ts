import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createUser, getUserByUsername } from "./local-auth-service.js";

/**
 * Ensure the local admin user exists on startup if
 * AGENTPULSE_LOCAL_ADMIN_USERNAME + _PASSWORD are set. Idempotent:
 *   - no env → do nothing (first-run signup path takes over)
 *   - env set, user missing → create admin
 *   - env set, user exists → rehash if password drifted, keep admin role
 *
 * The password is the source of truth when the env var is set, so
 * rotating it is the way to force a change.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
	const username = config.localAdminUsername.trim();
	const password = config.localAdminPassword;
	if (!username || !password) return;

	const existing = await getUserByUsername(username);
	if (!existing) {
		try {
			await createUser({ username, password, role: "admin" });
			console.log(`[auth] Bootstrap admin user "${username}" created.`);
		} catch (err) {
			console.error("[auth] Failed to create bootstrap admin:", err);
		}
		return;
	}

	// Realign role + password with env. Uses a fresh hash so the env
	// value rotating always takes effect on restart.
	try {
		const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
		await db
			.update(users)
			.set({
				passwordHash,
				role: "admin",
				disabledAt: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(users.id, existing.id));
		console.log(`[auth] Bootstrap admin "${username}" re-synced.`);
	} catch (err) {
		console.error("[auth] Failed to re-sync bootstrap admin:", err);
	}
}
