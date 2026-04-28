import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

// Defer DB-touching imports so __test_db can configure SQLITE_PATH first.
const { db, initializeDatabase } = await import("../../db/client.js");
const { settings } = await import("../../db/schema.js");
const {
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	invalidateAiFlagsCache,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
} = await import("./feature.js");
const { upsertSetting } = await import("../settings-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(settings).execute();
	invalidateAiFlagsCache();
});

afterEach(() => {
	invalidateAiFlagsCache();
});

// Wrap `db.select` so we can count the number of underlying SELECT statements
// the feature-flag readers issue. The wrapper returns the original chained
// builder unchanged; we just bump a counter when select() is called.
function spySelectCalls(): { count: () => number; restore: () => void } {
	const original = db.select.bind(db);
	let calls = 0;
	(db as unknown as { select: typeof db.select }).select = ((...args: unknown[]) => {
		calls += 1;
		// biome-ignore lint/suspicious/noExplicitAny: passing through to original
		return (original as any)(...args);
	}) as typeof db.select;
	return {
		count: () => calls,
		restore: () => {
			(db as unknown as { select: typeof db.select }).select = original;
		},
	};
}

describe("AI feature-flag cache", () => {
	test("isAiBuildEnabled is true under the test fixture", () => {
		// __test_db sets AGENTPULSE_AI_ENABLED=true and a 32+ char secrets key,
		// which is what `isAiBuildEnabled` reads. If this asserts false, every
		// downstream test in this file is meaningless — better to fail loudly.
		expect(isAiBuildEnabled()).toBe(true);
	});

	test("two reads within TTL hit DB once per key", async () => {
		// Seed runtime + kill-switch so isAiActive walks both paths.
		await upsertSetting(AI_RUNTIME_ENABLED_KEY, true, { allowProtected: true });
		await upsertSetting(AI_KILL_SWITCH_KEY, false, { allowProtected: true });
		invalidateAiFlagsCache();

		const spy = spySelectCalls();
		try {
			await isAiActive();
			const firstCount = spy.count();
			expect(firstCount).toBeGreaterThanOrEqual(1);

			await isAiActive();
			await isAiActive();
			// Second + third calls must be served from cache — no new selects.
			expect(spy.count()).toBe(firstCount);
		} finally {
			spy.restore();
		}
	});

	test("invalidateAiFlagsCache forces the next read to hit DB", async () => {
		await upsertSetting(AI_RUNTIME_ENABLED_KEY, true, { allowProtected: true });
		invalidateAiFlagsCache();

		const spy = spySelectCalls();
		try {
			await isAiRuntimeEnabled();
			const before = spy.count();
			expect(before).toBe(1);

			await isAiRuntimeEnabled();
			expect(spy.count()).toBe(before); // cached

			invalidateAiFlagsCache();
			await isAiRuntimeEnabled();
			expect(spy.count()).toBe(before + 1); // re-read after invalidate
		} finally {
			spy.restore();
		}
	});

	test("upsertSetting on ai.* invalidates the cache automatically", async () => {
		await upsertSetting(AI_RUNTIME_ENABLED_KEY, false, { allowProtected: true });
		invalidateAiFlagsCache();

		expect(await isAiRuntimeEnabled()).toBe(false);
		// Cached now.
		expect(await isAiRuntimeEnabled()).toBe(false);

		// Flip the underlying setting via the same write path that the AI router
		// uses. The post-write hook in settings-service must invalidate the
		// flag entry so the next reader sees the new value without waiting
		// for the TTL to expire.
		await upsertSetting(AI_RUNTIME_ENABLED_KEY, true, { allowProtected: true });
		expect(await isAiRuntimeEnabled()).toBe(true);
	});

	test("classifier flag default-on still caches", async () => {
		// Absent setting means classifier defaults to true. We want the cache
		// to remember "absent" so we don't re-query on every Inbox render.
		invalidateAiFlagsCache();
		const spy = spySelectCalls();
		try {
			expect(await isClassifierEnabled()).toBe(true);
			const before = spy.count();
			expect(await isClassifierEnabled()).toBe(true);
			expect(await isClassifierEnabled()).toBe(true);
			expect(spy.count()).toBe(before);
		} finally {
			spy.restore();
		}
	});

	test("kill switch toggle is reflected on next read after upsertSetting", async () => {
		await upsertSetting(AI_RUNTIME_ENABLED_KEY, true, { allowProtected: true });
		invalidateAiFlagsCache();

		expect(await isAiActive()).toBe(true);
		await upsertSetting(AI_KILL_SWITCH_KEY, true, { allowProtected: true });
		expect(await isKillSwitchActive()).toBe(true);
		expect(await isAiActive()).toBe(false);
	});
});
