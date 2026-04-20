import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiInboxSnoozes } = await import("../../db/schema.js");
const { listActiveSnoozes, snoozeItem, unsnooze, unsnoozeTarget } = await import(
	"./inbox-snooze-service.js"
);

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiInboxSnoozes).execute();
});

describe("inbox-snooze-service", () => {
	test("snooze creates a new active row", async () => {
		const until = new Date(Date.now() + 60_000);
		const s = await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until,
		});
		expect(s.kind).toBe("failed_proposal");
		expect(s.targetId).toBe("prop-1");

		const active = await listActiveSnoozes();
		expect(active.length).toBe(1);
	});

	test("snoozing the same target extends the deadline to the later of the two", async () => {
		const shorter = new Date(Date.now() + 60_000);
		const longer = new Date(Date.now() + 600_000);

		const a = await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until: shorter,
		});
		const b = await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until: longer,
		});
		expect(b.id).toBe(a.id); // upsert
		expect(b.snoozedUntil).toBe(longer.toISOString());

		const c = await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until: shorter,
		});
		// Should not shorten the deadline back to the earlier one.
		expect(c.snoozedUntil).toBe(longer.toISOString());
	});

	test("expired snoozes do not show in listActiveSnoozes", async () => {
		await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until: new Date(Date.now() - 10_000), // already expired
		});
		await snoozeItem({
			kind: "stuck",
			targetId: "session-a",
			until: new Date(Date.now() + 60_000),
		});
		const active = await listActiveSnoozes();
		expect(active.length).toBe(1);
		expect(active[0].kind).toBe("stuck");
	});

	test("unsnooze deletes by id", async () => {
		const s = await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-1",
			until: new Date(Date.now() + 60_000),
		});
		expect(await unsnooze(s.id)).toBe(true);
		expect((await listActiveSnoozes()).length).toBe(0);
	});

	test("unsnoozeTarget deletes by (kind, targetId)", async () => {
		await snoozeItem({
			kind: "failed_proposal",
			targetId: "prop-X",
			until: new Date(Date.now() + 60_000),
		});
		const ok = await unsnoozeTarget("failed_proposal", "prop-X");
		expect(ok).toBe(true);
		expect((await listActiveSnoozes()).length).toBe(0);
	});
});
