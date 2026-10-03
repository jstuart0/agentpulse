/**
 * On SQLite every statement runs synchronously on the event loop, so a stats
 * computation that never yields holds back everything queued behind it: with
 * several dashboards polling, an agent hook waits for every computation ahead
 * of it. Each heavy scan is therefore its own turn of the event loop, one at a
 * time in arrival order, so whatever else is waiting (a hook request, another
 * dashboard) is served between two scans instead of after all of them.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getStats } = await import("./session-tracker.js");

const OWNERS = Array.from(
	{ length: 10 },
	(_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
);

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb()
		.insert(sessions)
		.values(
			OWNERS.map((owner, i) => ({
				sessionId: `yield-${i}`,
				displayName: `yield-${i}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				ownerUserId: owner,
			})) as never,
		)
		.execute();
});

describeSqliteOnly("heavy scans take turns on the event loop (SQLite)", () => {
	test("work queued behind ten different dashboards' polls runs after at most one scan, not after all of them", async () => {
		let completed = 0;
		const polls = OWNERS.map((userId) =>
			getStats({ owner: { kind: "user", userId } }).then(() => {
				completed += 1;
			}),
		);
		// Stands in for an agent hook request that arrived just after the polls.
		const completedWhenOtherWorkRan = await new Promise<number>((resolve) => {
			setImmediate(() => resolve(completed));
		});
		await Promise.all(polls);
		expect(completedWhenOtherWorkRan).toBeLessThanOrEqual(1);
		expect(completed).toBe(OWNERS.length);
	});

	test("the event loop turns between scans: several polls take several turns", async () => {
		let turns = 0;
		let running = true;
		const tick = () => {
			if (!running) return;
			turns += 1;
			setImmediate(tick);
		};
		setImmediate(tick);
		await Promise.all(OWNERS.map((userId) => getStats({ owner: { kind: "user", userId } })));
		running = false;
		expect(turns).toBeGreaterThanOrEqual(OWNERS.length);
	});

	test("answers are unchanged by taking turns", async () => {
		const results = await Promise.all(
			OWNERS.map((userId) => getStats({ owner: { kind: "user", userId } })),
		);
		for (const stats of results) {
			expect(stats.total).toBe(1);
			expect(stats.operational.idle).toBe(1);
		}
	});
});
