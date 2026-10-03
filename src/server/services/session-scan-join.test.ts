/**
 * A poll whose candidate scan is shared with an operational list: when the list's
 * scan has already begun, the poll can no longer add its totals to it and takes a
 * scan of its own. Either way its counts describe the whole table.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const tracker = await import("./session-tracker.js");

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
afterEach(() => tracker._setOperationalCandidateCapForTest(null));

const now = () => new Date().toISOString();
const waiting = (tag: string, n: number) =>
	Array.from({ length: n }, (_, i) => ({
		sessionId: `${tag}-${i}`,
		displayName: `${tag}-${i}`,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		lastAgentTurnCompletedAt: now(),
		lastActivityAt: now(),
	}));

describeSqliteOnly("a poll that joins a list scan that has already started", () => {
	test("past the cap, a poll arriving between the list scan's turns still gets full counts", async () => {
		tracker._setOperationalCandidateCapForTest(3);
		await getDb()
			.insert(sessions)
			.values(waiting("w", 8) as never)
			.execute();
		const list = tracker.getSessions({ operational: "waiting", limit: 5 });
		let poll!: ReturnType<typeof tracker.getStats>;
		await new Promise<void>((resolve) =>
			setImmediate(() =>
				setImmediate(() => {
					poll = tracker.getStats();
					resolve();
				}),
			),
		);
		const [listed, stats] = await Promise.all([list, poll]);
		expect(listed.total).toBeGreaterThan(0);
		expect(stats.total).toBe(8);
		expect(stats.activeSessions).toBe(8);
		expect(stats.truncated).toBe(true);
	});

	test("a poll issued in the same turn as the list shares its scan and still gets full counts", async () => {
		await getDb()
			.insert(sessions)
			.values(waiting("w", 5) as never)
			.execute();
		const [listed, stats] = await Promise.all([
			tracker.getSessions({ operational: "waiting", limit: 5 }),
			tracker.getStats(),
		]);
		expect(listed.total).toBe(5);
		expect(stats.total).toBe(5);
		expect(stats.operational.waiting).toBe(5);
	});
});
