/**
 * Shared fixtures for route-level tests that need real callers: local users
 * with a session cookie, API keys (owned and ownerless), and the stored
 * instance mode. Not a test file.
 *
 * Every helper writes through the same service the app uses, so a fixture
 * can't drift from what production code would have stored.
 */
import { eq } from "drizzle-orm";
import { createApiKey } from "../auth/api-key.js";
import { getDb } from "../db/client.js";
import { settings, users } from "../db/schema/index.js";
import {
	type LocalUser,
	SESSION_COOKIE_NAME,
	createUser,
	issueSession,
} from "../services/local-auth-service.js";
import {
	ADMIN_SERVICE_KEY_IDS_SETTING,
	SERVICE_KEY_IDS_SETTING,
} from "../services/service-keys.js";
import { upsertSetting } from "../services/settings-service.js";

export const TEST_PASSWORD = "a-very-long-password-123";

export function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function seedLocalUser(
	label: string,
	role: "user" | "admin" = "user",
	opts: { mustChangePassword?: boolean } = {},
): Promise<LocalUser> {
	return createUser({
		username: uniqueName(label),
		password: TEST_PASSWORD,
		role,
		mustChangePassword: opts.mustChangePassword ?? false,
	});
}

/** Request headers carrying a fresh login cookie for the user. */
export async function cookieHeadersFor(userId: string): Promise<Headers> {
	const { token } = await issueSession({ userId });
	return new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` });
}

export function bearerHeaders(key: string, extra: Record<string, string> = {}): Headers {
	return new Headers({ Authorization: `Bearer ${key}`, ...extra });
}

/** An API key; ownerUserId null makes it a service key. */
export async function seedKey(
	label: string,
	scopes: string[],
	ownerUserId: string | null = null,
): Promise<{ id: string; key: string }> {
	return createApiKey(uniqueName(label), scopes, ownerUserId);
}

/** A service key an admin minted: no owner, the admin recorded as its creator. */
export async function seedAdminMintedServiceKey(
	label: string,
	scopes: string[],
	adminUserId: string,
): Promise<{ id: string; key: string }> {
	return createApiKey(uniqueName(label), scopes, adminUserId, { service: true });
}

/** Writes the stored mode directly (the env, when set, still wins). */
export async function setStoredMode(mode: "solo" | "team"): Promise<void> {
	await upsertSetting("instance.mode", mode, { allowProtected: true });
}

export async function setAdminServiceKeyList(ids: string[]): Promise<void> {
	await upsertSetting(ADMIN_SERVICE_KEY_IDS_SETTING, ids, { allowProtected: true });
}

export async function setServiceKeyList(ids: string[]): Promise<void> {
	await upsertSetting(SERVICE_KEY_IDS_SETTING, ids, { allowProtected: true });
}

export async function clearInstanceSettings(): Promise<void> {
	const rows = await getDb().select({ key: settings.key }).from(settings);
	for (const { key } of rows) {
		if (key.startsWith("instance.")) await getDb().delete(settings).where(eq(settings.key, key));
	}
}

export async function setUserRoleDirectly(userId: string, role: "user" | "admin"): Promise<void> {
	await getDb().update(users).set({ role }).where(eq(users.id, userId));
}

export async function disableUserDirectly(userId: string): Promise<void> {
	await getDb()
		.update(users)
		.set({ disabledAt: new Date().toISOString() })
		.where(eq(users.id, userId));
}

export function jsonRequest(
	method: string,
	body: unknown,
	headers: Headers = new Headers(),
): RequestInit {
	const merged = new Headers(headers);
	merged.set("Content-Type", "application/json");
	return { method, headers: merged, body: JSON.stringify(body) };
}
