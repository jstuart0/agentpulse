import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { llmProviders, sessions, settings, watcherConfigs } = await import("../../db/schema.js");
const { applyAskInitiatedWatcher } = await import("./auto-watcher.js");
const { AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY, AI_RUNTIME_ENABLED_KEY, invalidateAiFlagsCache } =
	await import("./feature.js");
const { getWatcherConfig, upsertWatcherConfig } = await import("./watcher-config-service.js");
const { encryptSecret, credentialHint } = await import("./secrets.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(watcherConfigs).execute();
	await db.delete(llmProviders).execute();
	await db.delete(settings).execute();
	await db.delete(sessions).execute();
	// These tests bypass `upsertSetting` (raw inserts) so the post-write
	// cache hook in settings-service never fires. Drop cached flags
	// manually so each case starts from a clean read.
	invalidateAiFlagsCache();
});

async function setRuntimeEnabled(enabled: boolean) {
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key: AI_RUNTIME_ENABLED_KEY, value: enabled, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: enabled, updatedAt: now },
		});
}

async function setAutoEnable(enabled: boolean) {
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key: AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY, value: enabled, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: enabled, updatedAt: now },
		});
}

async function mkSession(sessionId: string) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: new Date().toISOString(),
		})
		.execute();
}

async function mkDefaultProvider(): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db
		.insert(llmProviders)
		.values({
			id,
			userId: "local",
			name: "test-provider",
			kind: "anthropic",
			model: "claude-sonnet-4-6",
			baseUrl: null,
			credentialCiphertext: encryptSecret("sk-test-key"),
			credentialHint: credentialHint("sk-test-key"),
			isDefault: true,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return id;
}

describe("applyAskInitiatedWatcher", () => {
	test("auto-enables watcher when aiInitiated=true and AI is active and provider exists", async () => {
		await mkSession("s-ai");
		await mkDefaultProvider();
		await setRuntimeEnabled(true);

		await applyAskInitiatedWatcher("s-ai", { aiInitiated: true, askThreadId: "thread-1" });

		const cfg = await getWatcherConfig("s-ai");
		expect(cfg).not.toBeNull();
		expect(cfg?.enabled).toBe(true);
		expect(cfg?.policy).toBe("ask_on_risk");
	});

	test("no-op when aiInitiated is not true", async () => {
		await mkSession("s-manual");
		await mkDefaultProvider();
		await setRuntimeEnabled(true);

		await applyAskInitiatedWatcher("s-manual", { aiInitiated: false });
		await applyAskInitiatedWatcher("s-manual", {});
		await applyAskInitiatedWatcher("s-manual", null);

		expect(await getWatcherConfig("s-manual")).toBeNull();
	});

	test("no-op when AI runtime is disabled", async () => {
		await mkSession("s-off");
		await mkDefaultProvider();
		// Runtime not flipped on — isAiActive() returns false.

		await applyAskInitiatedWatcher("s-off", { aiInitiated: true });

		expect(await getWatcherConfig("s-off")).toBeNull();
	});

	test("no-op when user has opted out via the auto-enable setting", async () => {
		await mkSession("s-optout");
		await mkDefaultProvider();
		await setRuntimeEnabled(true);
		await setAutoEnable(false);

		await applyAskInitiatedWatcher("s-optout", { aiInitiated: true });

		expect(await getWatcherConfig("s-optout")).toBeNull();
	});

	test("no-op when no default provider is configured", async () => {
		await mkSession("s-noprov");
		await setRuntimeEnabled(true);
		// No provider inserted.

		await applyAskInitiatedWatcher("s-noprov", { aiInitiated: true });

		expect(await getWatcherConfig("s-noprov")).toBeNull();
	});

	test("does not clobber an existing watcher config", async () => {
		await mkSession("s-existing");
		const providerId = await mkDefaultProvider();
		await setRuntimeEnabled(true);
		// Pretend the user already configured this watcher manually with auto policy.
		await upsertWatcherConfig({
			sessionId: "s-existing",
			providerId,
			enabled: false,
			policy: "auto",
		});

		await applyAskInitiatedWatcher("s-existing", { aiInitiated: true });

		const cfg = await getWatcherConfig("s-existing");
		expect(cfg?.enabled).toBe(false);
		expect(cfg?.policy).toBe("auto");
	});
});
