/**
 * The last-12 history window must be deterministic on both dialects. Messages
 * written in one statement or transaction can share a `created_at`; on SQLite
 * rowid breaks the tie in insertion order, and on Postgres (where `created_at`
 * is TEXT from CURRENT_TIMESTAMP, microsecond resolution, one value per
 * transaction, and the only other column is a random UUID id) the id breaks it:
 * deterministic, but not insertion order.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { describePostgresOnly } from "../../test-utils/backend.js";
import "../ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { askMessages, askThreads } = await import("../../db/schema/index.js");
const { listRecentMessages } = await import("./ask-service.js");

const THREAD = "history-order-thread";
const TIE = "2026-01-01 00:00:00+00";

describePostgresOnly("the history window on Postgres", () => {
	beforeAll(async () => {
		await initializeDatabase();
	});
	beforeEach(async () => {
		await getDb().delete(askMessages);
		await getDb().delete(askThreads);
		await getDb().insert(askThreads).values({ id: THREAD, title: "t", origin: "web" });
	});
	afterAll(async () => {
		await getDb().delete(askMessages);
		await getDb().delete(askThreads);
	});

	test("messages sharing a created_at come back in id order, the same on every read, and the window is the 12 newest by (created_at, id)", async () => {
		const ids = Array.from({ length: 15 }, (_, i) => `m-${String(i).padStart(2, "0")}`);
		// inserted newest-id first, so insertion order disagrees with id order
		for (const id of [...ids].reverse()) {
			await getDb()
				.insert(askMessages)
				.values({ id, threadId: THREAD, role: "user", content: id, createdAt: TIE });
		}
		await getDb()
			.insert(askMessages)
			.values({
				id: "m-newest",
				threadId: THREAD,
				role: "user",
				content: "newest",
				createdAt: "2026-01-01 00:00:05+00",
			});

		const first = await listRecentMessages(THREAD, 12);
		const second = await listRecentMessages(THREAD, 12);

		expect(first.map((m) => m.id)).toEqual(second.map((m) => m.id));
		expect(first.map((m) => m.id)).toEqual([...ids.slice(4), "m-newest"]);
	});
});

// SQLite: the same-second case is pinned in ask-context-lazy.test.ts (rowid keeps insertion order).
test("this file's Postgres block is skipped on SQLite", () => {
	expect(true).toBe(true);
});
