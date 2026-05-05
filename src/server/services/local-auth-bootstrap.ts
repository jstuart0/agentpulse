import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { settings, users } from "../db/schema/index.js";
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
			// Mark first-run as complete so a later soft-delete of this admin
			// cannot re-open the signup window. The signup transaction checks
			// both the total user count AND this flag; writing it here ensures
			// the flag is set even if countActiveUsers() drops to 0 after a
			// disabledAt update.
			await getDb()
				.insert(settings)
				.values({
					key: "auth.firstRunCompleted",
					value: true,
					updatedAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: settings.key,
					set: { value: true, updatedAt: new Date().toISOString() },
				});
			console.log(`[auth] Bootstrap admin user "${username}" created.`);
		} catch (err) {
			console.error("[auth] Failed to create bootstrap admin:", err);
		}
		// S-M4: clear the in-process copy of the password after first use.
		// The env var is the source of truth on next restart; this prevents
		// any diagnostic dump or future serialization from capturing it.
		config.localAdminPassword = "";
		return;
	}

	// Realign role + password with env. Uses a fresh hash so the env
	// value rotating always takes effect on restart.
	try {
		const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
		await getDb()
			.update(users)
			.set({
				passwordHash,
				role: "admin",
				disabledAt: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(users.id, existing.id));
		// Re-sync also writes the flag: if the admin was soft-deleted between
		// restarts, this restart re-enables them AND re-asserts the flag so the
		// signup window stays closed for the duration of the soft-delete window.
		await getDb()
			.insert(settings)
			.values({
				key: "auth.firstRunCompleted",
				value: true,
				updatedAt: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: true, updatedAt: new Date().toISOString() },
			});
		console.log(`[auth] Bootstrap admin "${username}" re-synced.`);
	} catch (err) {
		console.error("[auth] Failed to re-sync bootstrap admin:", err);
	}
	// S-M4: clear the in-process copy after use on the re-sync path too.
	config.localAdminPassword = "";
}
