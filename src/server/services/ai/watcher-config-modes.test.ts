import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { llmProviders, sessions, settings, watcherConfigs } = await import(
	"../../db/schema/index.js"
);
const { AI_WATCHER_DEFAULTS_KEY, invalidateAiFlagsCache } = await import("./feature.js");
const {
	deleteWatcherConfig,
	getWatcherConfig,
	incrementContinuations,
	listWatchedSessionIds,
	upsertWatcherConfig,
} = await import("./watcher-config-service.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(watcherConfigs);
	await getDb().delete(settings).where(eq(settings.key, AI_WATCHER_DEFAULTS_KEY));
	invalidateAiFlagsCache();
	await getDb().delete(sessions);
	for (const id of ["m1", "m2", "m3"]) {
		await getDb().insert(sessions).values({ sessionId: id, agentType: "claude_code" });
	}
});

async function setDefaults(value: unknown) {
	const now = new Date().toISOString();
	await getDb()
		.insert(settings)
		.values({ key: AI_WATCHER_DEFAULTS_KEY, value, updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
	invalidateAiFlagsCache();
}

describe("modes", () => {
	test("a row shaped like the ones that predate the modes reads back as Continue-only", async () => {
		await getDb()
			.insert(watcherConfigs)
			.values({ sessionId: "m1", providerId: "p", enabled: true, policy: "ask_always" });
		const config = await getWatcherConfig("m1");
		expect(config?.continueEnabled).toBe(true);
		expect(config?.notifyEnabled).toBe(false);
	});

	test("a create without modes uses the shipped defaults: Notify on, Continue off", async () => {
		const config = await upsertWatcherConfig({ sessionId: "m1", providerId: "p", enabled: true });
		expect(config.notifyEnabled).toBe(true);
		expect(config.continueEnabled).toBe(false);
	});

	test("a create without modes uses the stored defaults, and a malformed value falls back to the shipped ones", async () => {
		await setDefaults({ notify: false, continue: true });
		const stored = await upsertWatcherConfig({ sessionId: "m1", providerId: "p", enabled: true });
		expect([stored.notifyEnabled, stored.continueEnabled]).toEqual([false, true]);

		await setDefaults({ notify: "yes", continue: true });
		const malformed = await upsertWatcherConfig({
			sessionId: "m2",
			providerId: "p",
			enabled: true,
		});
		expect([malformed.notifyEnabled, malformed.continueEnabled]).toEqual([true, false]);
	});

	test("explicit modes on create win over the defaults", async () => {
		const config = await upsertWatcherConfig({
			sessionId: "m1",
			providerId: "p",
			notifyEnabled: false,
			continueEnabled: true,
		});
		expect([config.notifyEnabled, config.continueEnabled]).toEqual([false, true]);
	});

	test("updating one mode leaves the other unchanged", async () => {
		await upsertWatcherConfig({
			sessionId: "m1",
			providerId: "p",
			enabled: true,
			notifyEnabled: true,
			continueEnabled: true,
		});
		const a = await upsertWatcherConfig({ sessionId: "m1", notifyEnabled: false });
		expect([a.notifyEnabled, a.continueEnabled]).toEqual([false, true]);
		const b = await upsertWatcherConfig({ sessionId: "m1", continueEnabled: false });
		expect([b.notifyEnabled, b.continueEnabled]).toEqual([false, false]);
	});

	test("listWatchedSessionIds: enabled with at least one mode on", async () => {
		await upsertWatcherConfig({
			sessionId: "m1",
			providerId: "p",
			enabled: true,
			notifyEnabled: true,
			continueEnabled: false,
		});
		await upsertWatcherConfig({
			sessionId: "m2",
			providerId: "p",
			enabled: true,
			notifyEnabled: false,
			continueEnabled: false,
		});
		await upsertWatcherConfig({
			sessionId: "m3",
			providerId: "p",
			enabled: false,
			notifyEnabled: true,
			continueEnabled: true,
		});
		expect(await listWatchedSessionIds()).toEqual(["m1"]);
	});
});

describe("the continuation counter", () => {
	async function seedCounter(used = 0) {
		await upsertWatcherConfig({ sessionId: "m1", providerId: "p", enabled: true });
		await getDb()
			.update(watcherConfigs)
			.set({ continuationsUsed: used })
			.where(eq(watcherConfigs.sessionId, "m1"));
	}

	test("two concurrent increments end at +2", async () => {
		await seedCounter(3);
		const results = await Promise.all([incrementContinuations("m1"), incrementContinuations("m1")]);
		expect([...results].sort()).toEqual([4, 5]);
		expect((await getWatcherConfig("m1"))?.continuationsUsed).toBe(5);
	});

	test("an increment racing a toggle is never lost (20 rounds)", async () => {
		for (let round = 0; round < 20; round += 1) {
			await seedCounter(0);
			await Promise.all([
				incrementContinuations("m1"),
				upsertWatcherConfig({ sessionId: "m1", enabled: round % 2 === 0 }),
			]);
			expect((await getWatcherConfig("m1"))?.continuationsUsed, `round ${round}`).toBe(1);
		}
	});

	test("re-enabling leaves the counter alone; only an explicit reset zeroes it", async () => {
		await seedCounter(7);
		await upsertWatcherConfig({ sessionId: "m1", enabled: false });
		const reEnabled = await upsertWatcherConfig({ sessionId: "m1", enabled: true });
		expect(reEnabled.continuationsUsed).toBe(7);
		const reset = await upsertWatcherConfig({ sessionId: "m1", resetContinuations: true });
		expect(reset.continuationsUsed).toBe(0);
	});

	test("incrementing a missing config answers 0 and creates nothing", async () => {
		expect(await incrementContinuations("m1")).toBe(0);
		expect(await getWatcherConfig("m1")).toBeNull();
	});
});

describe("confirming auto", () => {
	test("auto needs a confirmer: without one the service throws", async () => {
		await expect(
			upsertWatcherConfig({ sessionId: "m1", providerId: "p", policy: "auto" }),
		).rejects.toThrow(/autoConfirmedBy/);
		expect(await getWatcherConfig("m1")).toBeNull();
	});

	test("with a confirmer both columns are stamped; a later other policy clears them", async () => {
		const auto = await upsertWatcherConfig({
			sessionId: "m1",
			providerId: "p",
			policy: "auto",
			autoConfirmedBy: "user-1",
		});
		expect(auto.autoConfirmedBy).toBe("user-1");
		expect(auto.autoConfirmedAt).not.toBeNull();

		const asking = await upsertWatcherConfig({ sessionId: "m1", policy: "ask_always" });
		expect(asking.autoConfirmedAt).toBeNull();
		expect(asking.autoConfirmedBy).toBeNull();
	});

	test("the confirmation lapses on a changed system prompt, provider or limit, but not on a mode toggle", async () => {
		const confirmed = async () =>
			upsertWatcherConfig({
				sessionId: "m1",
				providerId: "p",
				policy: "auto",
				autoConfirmedBy: "user-1",
				maxContinuations: 10,
			});

		for (const change of [
			{ systemPrompt: "x" },
			{ providerId: "other-provider" },
			{ maxContinuations: 5 },
		]) {
			await getDb().delete(watcherConfigs);
			await confirmed();
			const after = await upsertWatcherConfig({ sessionId: "m1", ...change });
			expect(after.autoConfirmedAt, JSON.stringify(change)).toBeNull();
			expect(after.autoConfirmedBy, JSON.stringify(change)).toBeNull();
			expect(after.policy).toBe("auto");
		}

		// Named member: a mode toggle changes nothing the confirmation covered.
		await getDb().delete(watcherConfigs);
		await confirmed();
		const toggled = await upsertWatcherConfig({ sessionId: "m1", notifyEnabled: false });
		expect(toggled.autoConfirmedBy).toBe("user-1");

		// Sending the value it already has is not a change.
		const same = await upsertWatcherConfig({ sessionId: "m1", maxContinuations: 10 });
		expect(same.autoConfirmedBy).toBe("user-1");
	});

	test("re-sending policy auto with a confirmer re-confirms", async () => {
		await upsertWatcherConfig({
			sessionId: "m1",
			providerId: "p",
			policy: "auto",
			autoConfirmedBy: "user-1",
		});
		await upsertWatcherConfig({ sessionId: "m1", systemPrompt: "new" });
		const again = await upsertWatcherConfig({
			sessionId: "m1",
			policy: "auto",
			autoConfirmedBy: "user-2",
		});
		expect(again.autoConfirmedBy).toBe("user-2");
	});
});

describe("deleteWatcherConfig", () => {
	test("reports whether a row existed", async () => {
		await upsertWatcherConfig({ sessionId: "m1", providerId: "p" });
		expect(await deleteWatcherConfig("m1")).toBe(true);
		expect(await deleteWatcherConfig("m1")).toBe(false);
	});
});

// The provider id column has no FK, so these tests need no provider rows.
void llmProviders;
