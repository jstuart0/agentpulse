// AGEN-24 — event retention: disabled-by-default, batched delete, FTS
// consistency, and non-blocking concurrent ingest.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { eq } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions, settings } = await import("../db/schema/index.js");
const { upsertSetting } = await import("./settings-service.js");
const { getSearchBackend, __resetSearchBackendForTests } = await import("./search/index.js");
const { toDbTimestamp } = await import("./util/db-time.js");
const {
	runRetentionPass,
	_resetRetentionStateForTest,
	_setRetentionBatchSizeForTest,
	getRetentionStatus,
} = await import("./retention-service.js");

beforeAll(() => {
	return initializeDatabase();
});

afterEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(settings).execute();
	_resetRetentionStateForTest();
	_setRetentionBatchSizeForTest(null);
	__resetSearchBackendForTests();
});

function daysAgo(n: number): string {
	return toDbTimestamp(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}

async function seedSession(sessionId: string): Promise<void> {
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" }).execute();
}

async function seedEvent(
	sessionId: string,
	createdAt: string,
	content: string | null = null,
	eventType = "UserPromptSubmit",
): Promise<void> {
	await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType,
			rawPayload: { prompt: content ?? "noop" },
			content,
			source: "observed_hook",
			createdAt,
		})
		.execute();
}

async function countEvents(sessionId: string): Promise<number> {
	const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	return rows.length;
}

describe("runRetentionPass", () => {
	test("disabled by default (no setting row): nothing deleted", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(400));
		await seedEvent("s1", daysAgo(1));

		const result = await runRetentionPass();
		expect(result.disabled).toBe(true);
		expect(result.rowsDeleted).toBe(0);
		expect(await countEvents("s1")).toBe(2);
	});

	test("disabled when eventsRetentionDays is explicitly 0", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(400));
		await upsertSetting("eventsRetentionDays", 0);

		const result = await runRetentionPass();
		expect(result.disabled).toBe(true);
		expect(result.rowsDeleted).toBe(0);
		expect(await countEvents("s1")).toBe(1);
	});

	test("enabled: deletes only rows older than the cutoff", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(10), "old-event-keep-nothing");
		await seedEvent("s1", daysAgo(1), "fresh-event-keep-me");
		await upsertSetting("eventsRetentionDays", 7);

		const result = await runRetentionPass();
		expect(result.disabled).toBe(false);
		expect(result.retentionDays).toBe(7);
		expect(result.rowsDeleted).toBe(1);

		const remaining = await getDb().select().from(events).where(eq(events.sessionId, "s1"));
		expect(remaining.length).toBe(1);
		expect(remaining[0].content).toBe("fresh-event-keep-me");
	});

	test("never touches the session row", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(10));
		await upsertSetting("eventsRetentionDays", 7);

		await runRetentionPass();

		const sessionRows = await getDb().select().from(sessions).where(eq(sessions.sessionId, "s1"));
		expect(sessionRows.length).toBe(1);
	});

	test("deletes across multiple batches when the backlog exceeds one batch", async () => {
		await seedSession("s1");
		_setRetentionBatchSizeForTest(2);
		for (let i = 0; i < 5; i++) {
			await seedEvent("s1", daysAgo(10 + i));
		}
		await upsertSetting("eventsRetentionDays", 5);

		const result = await runRetentionPass();
		expect(result.rowsDeleted).toBe(5);
		expect(result.batches).toBe(3); // 2 + 2 + 1
		expect(await countEvents("s1")).toBe(0);
	});

	test("FTS/search stays consistent: deleted events stop matching, kept events still match", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(10), "obsolete needle-alpha content", "UserPromptSubmit");
		await seedEvent("s1", daysAgo(1), "current needle-beta content", "UserPromptSubmit");
		await upsertSetting("eventsRetentionDays", 5);

		await runRetentionPass();

		const backend = getSearchBackend();
		const staleHits = await backend.search({ q: "needle-alpha", kinds: ["event"] });
		expect(staleHits.hits.length).toBe(0);

		const freshHits = await backend.search({ q: "needle-beta", kinds: ["event"] });
		expect(freshHits.hits.length).toBeGreaterThanOrEqual(1);
	});

	test("concurrent ingest during a pass is not blocked or lost", async () => {
		await seedSession("s1");
		_setRetentionBatchSizeForTest(10);
		for (let i = 0; i < 100; i++) {
			await seedEvent("s1", daysAgo(30));
		}
		await upsertSetting("eventsRetentionDays", 5);

		const passPromise = runRetentionPass();
		const ingestPromise = seedEvent("s1", daysAgo(0), "written-during-the-pass");

		const [result] = await Promise.all([passPromise, ingestPromise]);

		expect(result.rowsDeleted).toBe(100);
		expect(result.batches).toBe(10);

		const survivor = await getDb()
			.select()
			.from(events)
			.where(eq(events.content, "written-during-the-pass"));
		expect(survivor.length).toBe(1);
	});

	test("a second concurrent call is skipped as already_running", async () => {
		await seedSession("s1");
		_setRetentionBatchSizeForTest(1);
		for (let i = 0; i < 20; i++) {
			await seedEvent("s1", daysAgo(30));
		}
		await upsertSetting("eventsRetentionDays", 5);

		const [first, second] = await Promise.all([runRetentionPass(), runRetentionPass()]);
		const skipped = [first, second].find((r) => r.skippedReason === "already_running");
		const ran = [first, second].find((r) => r.skippedReason !== "already_running");
		expect(skipped).toBeDefined();
		expect(ran).toBeDefined();
		expect(ran?.rowsDeleted).toBe(20);
	});

	test("getRetentionStatus reflects the last run", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(10));
		await upsertSetting("eventsRetentionDays", 5);

		await runRetentionPass();
		const status = getRetentionStatus();
		expect(status.lastRun?.rowsDeleted).toBe(1);
		expect(status.lastRun?.disabled).toBe(false);
	});

	describeSqliteOnly("SQLite-specific", () => {
		test("no PRAGMA incremental_vacuum crash when auto_vacuum is NONE (default)", async () => {
			// Existing installs are auto_vacuum=NONE; the pass must not attempt
			// (or fail on) incremental_vacuum in that case — just skip it.
			await seedSession("s1");
			await seedEvent("s1", daysAgo(10));
			await upsertSetting("eventsRetentionDays", 5);

			await expect(runRetentionPass()).resolves.toMatchObject({ rowsDeleted: 1 });
		});
	});

	describePostgresOnly("Postgres-specific", () => {
		test("advisory lock is released after the pass (a second immediate pass is not blocked)", async () => {
			await seedSession("s1");
			await seedEvent("s1", daysAgo(10));
			await seedEvent("s1", daysAgo(9));
			await upsertSetting("eventsRetentionDays", 5);

			const first = await runRetentionPass();
			expect(first.skippedReason).toBeUndefined();
			expect(first.rowsDeleted).toBe(2);

			// Nothing left to delete, but the lock must not still be held —
			// this proves pg_try_advisory_xact_lock released at commit.
			const second = await runRetentionPass();
			expect(second.skippedReason).toBeUndefined();
			expect(second.rowsDeleted).toBe(0);
		});
	});
});
