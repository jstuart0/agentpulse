/**
 * resetIdentityState: a row left behind in users/auth_sessions/api_keys/
 * settings by one test file must not leak into a later file's count-
 * sensitive assertion.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import "../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, authSessions, settings, users } = await import("../db/schema/index.js");
const { createApiKey } = await import("../auth/api-key.js");
const { resetIdentityState } = await import("./identity-reset.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function seedOneOfEverything(): Promise<void> {
	const now = new Date().toISOString();
	const [user] = await getDb()
		.insert(users)
		.values({
			username: `reset-test-user-${crypto.randomUUID()}`,
			passwordHash: "!",
			role: "user",
			authSource: "local",
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	await getDb()
		.insert(authSessions)
		.values({
			tokenHash: `reset-test-token-hash-${crypto.randomUUID()}`,
			userId: user.id,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			createdAt: now,
		});
	await createApiKey(`reset-test-key-${crypto.randomUUID()}`);
	await getDb()
		.insert(settings)
		.values({ key: "auth.firstRunCompleted", value: "true", updatedAt: now });
	await getDb()
		.insert(settings)
		.values({ key: "instance.mode", value: "multi-user", updatedAt: now });
}

describe("resetIdentityState clears users, auth_sessions, api_keys, and instance.*/first-run settings", () => {
	test("every one of those is empty after reset, even when all were seeded", async () => {
		await seedOneOfEverything();

		const [usersBefore, sessionsBefore, keysBefore, settingsBefore] = await Promise.all([
			getDb().select().from(users),
			getDb().select().from(authSessions),
			getDb().select().from(apiKeys),
			getDb().select().from(settings),
		]);
		expect(usersBefore.length).toBeGreaterThan(0);
		expect(sessionsBefore.length).toBeGreaterThan(0);
		expect(keysBefore.length).toBeGreaterThan(0);
		expect(settingsBefore.some((s) => s.key === "auth.firstRunCompleted")).toBe(true);
		expect(settingsBefore.some((s) => s.key.startsWith("instance."))).toBe(true);

		await resetIdentityState();

		const [usersAfter, sessionsAfter, keysAfter] = await Promise.all([
			getDb().select().from(users),
			getDb().select().from(authSessions),
			getDb().select().from(apiKeys),
		]);
		expect(usersAfter).toHaveLength(0);
		expect(sessionsAfter).toHaveLength(0);
		expect(keysAfter).toHaveLength(0);

		const firstRun = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, "auth.firstRunCompleted"));
		expect(firstRun).toHaveLength(0);

		const instanceKeys = await getDb()
			.select()
			.from(settings)
			.where(like(settings.key, "instance.%"));
		expect(instanceKeys).toHaveLength(0);
	});

	test("does not recreate the default bootstrap API key — callers opt in via ensureDefaultApiKey()", async () => {
		await resetIdentityState();
		const rows = await getDb().select().from(apiKeys);
		expect(rows).toHaveLength(0);
	});

	test("a non-instance-prefixed setting survives the reset (only instance.* and auth.firstRunCompleted are targeted)", async () => {
		const now = new Date().toISOString();
		await getDb()
			.insert(settings)
			.values({ key: "unrelated.setting", value: "keep-me", updatedAt: now })
			.onConflictDoNothing();

		await resetIdentityState();

		const row = await getDb().select().from(settings).where(eq(settings.key, "unrelated.setting"));
		expect(row).toHaveLength(1);

		// Clean up after ourselves — this file doesn't own this row long-term.
		await getDb().delete(settings).where(eq(settings.key, "unrelated.setting"));
	});
});
