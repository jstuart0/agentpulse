/**
 * `ownsThread` (push targeting) and `ownsThreadCondition` (the thread read/list/archive WHERE) are one
 * rule written twice. This holds them together: for every owner shape and reader shape, the rows the SQL
 * condition returns are exactly the ones the function accepts. Both dialects.
 */
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import "../../db/__test_db.js";

setDefaultTimeout(60_000);

const { eq, and } = await import("drizzle-orm");
const { initializeDatabase, getDb } = await import("../../db/client.js");
const { askThreads } = await import("../../db/schema/index.js");
const { ownsThread, ownsThreadCondition } = await import("./thread-ownership.js");

beforeAll(() => initializeDatabase(), 60_000);
afterEach(async () => {
	await getDb().delete(askThreads);
}, 60_000);

const IDS = [null, "u1", "u2"] as const;
const KEYS = [null, "k1", "k2"] as const;

describe("ownsThread", () => {
	// [owner user, owner key, reader user, reader key, owns]
	const TABLE: Array<[string | null, string | null, string | null, string | null, boolean]> = [
		["u1", null, "u1", null, true],
		["u1", null, "u1", "k9", true],
		["u1", null, "u2", "k1", false],
		["u1", "k1", "u2", "k1", false],
		[null, "k1", null, "k1", true],
		[null, "k1", "u1", "k1", true],
		[null, "k1", null, "k2", false],
		[null, "k1", "u1", null, false],
		[null, null, "u1", "k1", false],
		[null, null, null, null, false],
	];
	for (const [ownerUserId, ownerKeyId, userId, keyId, owns] of TABLE) {
		test(`thread(user ${ownerUserId}, key ${ownerKeyId}) read by (user ${userId}, key ${keyId}): ${owns}`, () => {
			expect(ownsThread({ ownerUserId, ownerKeyId }, { userId, keyId })).toBe(owns);
		});
	}
});

describe("the SQL condition and the function agree", () => {
	test("every owner shape against every reader shape", async () => {
		const made: Array<{ id: string; ownerUserId: string | null; ownerKeyId: string | null }> = [];
		for (const ownerUserId of IDS) {
			for (const ownerKeyId of KEYS) {
				const [row] = await getDb()
					.insert(askThreads)
					.values({ title: "t", origin: "web", ownerUserId, ownerKeyId } as never)
					.returning();
				made.push({ id: (row as { id: string }).id, ownerUserId, ownerKeyId });
			}
		}
		let compared = 0;
		for (const userId of IDS) {
			for (const keyId of KEYS) {
				const sqlIds = (
					await getDb()
						.select({ id: askThreads.id })
						.from(askThreads)
						.where(and(ownsThreadCondition({ userId, keyId }), eq(askThreads.origin, "web")))
				)
					.map((r) => r.id)
					.sort();
				const fnIds = made
					.filter((t) => ownsThread(t, { userId, keyId }))
					.map((t) => t.id)
					.sort();
				expect({ userId, keyId, ids: sqlIds }).toEqual({ userId, keyId, ids: fnIds });
				compared++;
			}
		}
		expect(made).toHaveLength(9);
		expect(compared).toBe(9);
	});
});
