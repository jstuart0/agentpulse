// AGEN-24 — event retention: disabled-by-default, batched delete, FTS
// consistency, and non-blocking concurrent ingest.
//
// Also covers percy's follow-up review (TB10): SQLite batch-size tuning,
// per-batch Postgres advisory-lock re-acquisition, and skipped-pass
// reporting for /health.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { eq, sql } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { withTransaction } = await import("../db/with-transaction.js");
const { events, sessions, settings } = await import("../db/schema/index.js");
const { upsertSetting } = await import("./settings-service.js");
const { getSearchBackend, __resetSearchBackendForTests } = await import("./search/index.js");
const { toDbTimestamp } = await import("./util/db-time.js");
const {
	runRetentionPass,
	_resetRetentionStateForTest,
	_setRetentionBatchSizeForTest,
	getRetentionStatus,
	getRetentionLimits,
	PG_RETENTION_LOCK_ID,
	deleteExpiredSummaries,
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

	test("getRetentionLimits reports the tuned batch size and safety cap (percy TB10)", () => {
		const limits = getRetentionLimits();
		expect(limits.defaultBatchSize).toBe(1_000);
		expect(limits.maxBatchesPerPass).toBe(1_000);
		// The 1M-rows-per-pass safety cap must survive the batch-size retune.
		expect(limits.defaultBatchSize * limits.maxBatchesPerPass).toBe(1_000_000);
	});

	test("a skipped already_running pass is recorded as lastSkip for /health", async () => {
		await seedSession("s1");
		_setRetentionBatchSizeForTest(1);
		for (let i = 0; i < 20; i++) {
			await seedEvent("s1", daysAgo(30));
		}
		await upsertSetting("eventsRetentionDays", 5);

		await Promise.all([runRetentionPass(), runRetentionPass()]);
		const status = getRetentionStatus();
		expect(status.lastSkip?.reason).toBe("already_running");
	});

	test("the batch-select query plan uses an index, not a table scan (percy TB10 item 2)", async () => {
		await seedSession("s1");
		await seedEvent("s1", daysAgo(10));
		const cutoff = daysAgo(5);

		if (config.dialect === "postgres") {
			// The test table has only a handful of rows, so Postgres's
			// cost-based planner would otherwise legitimately prefer a Seq
			// Scan + Sort over the index — that's a table-size artifact, not
			// evidence the index is unusable. `enable_seqscan = off` (scoped
			// to one transaction via SET LOCAL) forces the planner to route
			// through any index that satisfies the query, so this asserts
			// the index CAN satisfy the exact WHERE + ORDER BY + LIMIT shape
			// deleteBatch() issues, regardless of row count.
			let planText = "";
			await withTransaction(async (tx) => {
				await tx.execute(sql`SET LOCAL enable_seqscan = off`);
				const rows: Array<{ "QUERY PLAN": string }> = await tx.execute(
					sql`EXPLAIN SELECT id FROM events WHERE created_at < ${cutoff} ORDER BY created_at ASC, id ASC LIMIT 1000`,
				);
				planText = rows.map((r) => r["QUERY PLAN"]).join("\n");
			});
			expect(planText).toContain("idx_events_created_at_id");
		} else {
			const raw = getSqlite();
			const rows = raw
				.prepare(
					"EXPLAIN QUERY PLAN SELECT id FROM events WHERE created_at < ? ORDER BY created_at ASC, id ASC LIMIT 1000",
				)
				.all(cutoff) as Array<{ detail: string }>;
			const planText = rows.map((r) => r.detail).join("\n");
			// SQLite always appends the rowid to a non-unique index's key
			// internally, so the pre-existing single-column idx_events_created_at
			// already satisfies this WHERE + ORDER BY as a covering index on an
			// install whose base schema predates migration 0005 (legacy init
			// path) — that's an equally valid, equally non-scanning plan to the
			// new idx_events_created_at_id (which a fresh Drizzle-migrate
			// install picks instead). Either is the percy-measured fix: no
			// table SCAN, an index whose key starts with created_at.
			expect(planText).toMatch(/USING (COVERING )?INDEX idx_events_created_at/);
		}
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

		test("stops and reports lock_held_elsewhere when another session holds the lock (percy TB10 item 4)", async () => {
			await seedSession("s1");
			await seedEvent("s1", daysAgo(10));
			await upsertSetting("eventsRetentionDays", 5);

			const postgres = (await import("postgres")).default;
			// Session-level pg_advisory_lock on the SAME lock id conflicts with
			// runRetentionPass's per-batch pg_try_advisory_xact_lock — this
			// simulates a second replica already running a pass.
			const holder = postgres(config.databaseUrl, { max: 1 });
			try {
				await holder`SELECT pg_advisory_lock(${PG_RETENTION_LOCK_ID})`;

				const result = await runRetentionPass();
				expect(result.skippedReason).toBe("lock_held_elsewhere");
				expect(result.rowsDeleted).toBe(0);
				expect(await countEvents("s1")).toBe(1); // untouched — pass stopped, not partially applied

				const status = getRetentionStatus();
				expect(status.lastSkip?.reason).toBe("lock_held_elsewhere");
			} finally {
				await holder`SELECT pg_advisory_unlock(${PG_RETENTION_LOCK_ID})`;
				await holder.end();
			}

			// Lock released — a follow-up pass now proceeds normally.
			const after = await runRetentionPass();
			expect(after.skippedReason).toBeUndefined();
			expect(after.rowsDeleted).toBe(1);
		});

		test("re-acquires the lock per batch: multiple batches still complete when uncontended", async () => {
			await seedSession("s1");
			_setRetentionBatchSizeForTest(2);
			for (let i = 0; i < 5; i++) {
				await seedEvent("s1", daysAgo(10 + i));
			}
			await upsertSetting("eventsRetentionDays", 5);

			const result = await runRetentionPass();
			expect(result.skippedReason).toBeUndefined();
			expect(result.rowsDeleted).toBe(5);
			expect(result.batches).toBe(3); // 2 + 2 + 1, each its own transaction+lock
		});
	});
});

// ── AGEN-69 phase 5: the retention pass also deletes expired session summaries ──
describe("retention of session summaries (TC-5.45, 5.56, 5.57)", () => {
	const NOW = new Date(Date.UTC(2031, 5, 15, 12, 0, 0));
	const DAY = 24 * 60 * 60 * 1000;
	const LEASE_MS = 300 * 1000;
	const at = (ms: number) => toDbTimestamp(new Date(ms));
	const CUTOFF_MS = NOW.getTime() - 30 * DAY;

	async function seedSummary(
		sessionId: string,
		row: Partial<typeof import("../db/schema/index.js")["aiSessionSummaries"]["$inferInsert"]>,
	): Promise<void> {
		const { aiSessionSummaries } = await import("../db/schema/index.js");
		await seedSession(sessionId);
		await getDb()
			.insert(aiSessionSummaries)
			.values({ sessionId, ...row });
	}
	async function present(sessionId: string): Promise<boolean> {
		const { aiSessionSummaries } = await import("../db/schema/index.js");
		const rows = await getDb()
			.select({ id: aiSessionSummaries.sessionId })
			.from(aiSessionSummaries)
			.where(eq(aiSessionSummaries.sessionId, sessionId));
		return rows.length === 1;
	}

	test("TC-5.45 a summary older than the cutoff goes; 1 s older is deleted, exactly at and 1 s newer are kept; summariesDeleted is reported", async () => {
		await upsertSetting("eventsRetentionDays", 30);
		await seedSummary("old", { generatedAt: at(CUTOFF_MS - 1000), attemptStatus: "idle" });
		await seedSummary("edge", { generatedAt: at(CUTOFF_MS), attemptStatus: "idle" });
		await seedSummary("new", { generatedAt: at(CUTOFF_MS + 1000), attemptStatus: "failed" });
		const result = await runRetentionPass(NOW);
		expect(result.summariesDeleted).toBe(1);
		expect(await present("old")).toBe(false);
		expect(await present("edge")).toBe(true);
		expect(await present("new")).toBe(true);
	});

	test("TC-5.45 retention disabled deletes no summary and reports 0", async () => {
		await seedSummary("old", { generatedAt: at(CUTOFF_MS - 10 * DAY), attemptStatus: "idle" });
		const result = await runRetentionPass(NOW);
		expect(result.disabled).toBe(true);
		expect(result.summariesDeleted).toBe(0);
		expect(await present("old")).toBe(true);
	});

	test("TC-5.56 a generating row whose lease has lapsed is deleted; one inside its lease and one with NULL generated_at are kept", async () => {
		await upsertSetting("eventsRetentionDays", 30);
		const old = at(CUTOFF_MS - DAY);
		await seedSummary("crashed", {
			generatedAt: old,
			attemptStatus: "generating",
			attemptStartedAt: at(NOW.getTime() - LEASE_MS - 1000),
			attemptToken: "t",
		});
		await seedSummary("running", {
			generatedAt: old,
			attemptStatus: "generating",
			attemptStartedAt: at(NOW.getTime() - LEASE_MS),
			attemptToken: "t",
		});
		await seedSummary("never", {
			generatedAt: null,
			attemptStatus: "failed",
			attemptStartedAt: old,
		});
		const result = await runRetentionPass(NOW);
		expect(result.summariesDeleted).toBe(1);
		expect(await present("crashed")).toBe(false);
		expect(await present("running")).toBe(true);
		expect(await present("never")).toBe(true);
	});

	describeSqliteOnly("on SQLite", () => {
		test("TC-5.57 the summary delete runs after the events batches in the same pass", async () => {
			await upsertSetting("eventsRetentionDays", 30);
			await seedSummary("old", { generatedAt: at(CUTOFF_MS - DAY), attemptStatus: "idle" });
			await seedEvent("old", at(CUTOFF_MS - DAY));
			const result = await runRetentionPass(NOW);
			expect(result.rowsDeleted).toBe(1);
			expect(result.summariesDeleted).toBe(1);
		});
	});

	describePostgresOnly("on Postgres", () => {
		test("TC-5.57 with the retention lock held by another session nothing is deleted, summariesDeleted is 0 and a skip is reported", async () => {
			await upsertSetting("eventsRetentionDays", 30);
			await seedSummary("old", { generatedAt: at(CUTOFF_MS - DAY), attemptStatus: "idle" });
			const postgres = (await import("postgres")).default;
			const holder = postgres(config.databaseUrl, { max: 1 });
			try {
				await holder`SELECT pg_advisory_lock(${PG_RETENTION_LOCK_ID})`;
				const result = await runRetentionPass(NOW);
				expect(result.skippedReason).toBe("lock_held_elsewhere");
				expect(result.summariesDeleted).toBe(0);
				expect(await present("old")).toBe(true);
				expect(getRetentionStatus().lastSkip?.reason).toBe("lock_held_elsewhere");
			} finally {
				await holder`SELECT pg_advisory_unlock(${PG_RETENTION_LOCK_ID})`;
				await holder.end({ timeout: 2 });
			}
			const after = await runRetentionPass(NOW);
			expect(after.skippedReason).toBeUndefined();
			expect(after.summariesDeleted).toBe(1);
		});

		test("TC-5.57 the summary delete takes the lock itself: held elsewhere, it deletes nothing and says so", async () => {
			await seedSummary("old", { generatedAt: at(CUTOFF_MS - DAY), attemptStatus: "idle" });
			const postgres = (await import("postgres")).default;
			const holder = postgres(config.databaseUrl, { max: 1 });
			try {
				await holder`SELECT pg_advisory_lock(${PG_RETENTION_LOCK_ID})`;
				const held = await deleteExpiredSummaries(at(CUTOFF_MS), at(NOW.getTime() - LEASE_MS));
				expect(held).toEqual({ deleted: 0, lockLost: true });
				expect(await present("old")).toBe(true);
			} finally {
				await holder`SELECT pg_advisory_unlock(${PG_RETENTION_LOCK_ID})`;
				await holder.end({ timeout: 2 });
			}
			const free = await deleteExpiredSummaries(at(CUTOFF_MS), at(NOW.getTime() - LEASE_MS));
			expect(free).toEqual({ deleted: 1, lockLost: false });
		});
	});

	// ── P5-21: the summaries delete is batched (500 rows), yields on SQLite, re-takes the lock per batch on Postgres ──
	async function seedExpiredSummaries(count: number): Promise<string[]> {
		const { aiSessionSummaries } = await import("../db/schema/index.js");
		const ids = Array.from({ length: count }, (_, i) => `bulk-${i}`);
		for (let i = 0; i < ids.length; i += 200) {
			const chunk = ids.slice(i, i + 200);
			await getDb()
				.insert(sessions)
				.values(chunk.map((sessionId) => ({ sessionId, agentType: "claude_code" })));
			await getDb()
				.insert(aiSessionSummaries)
				.values(
					chunk.map((sessionId) => ({
						sessionId,
						generatedAt: at(CUTOFF_MS - DAY),
						attemptStatus: "idle",
					})),
				);
		}
		return ids;
	}
	const count = async (): Promise<number> => {
		const { aiSessionSummaries } = await import("../db/schema/index.js");
		return (await getDb().select({ id: aiSessionSummaries.sessionId }).from(aiSessionSummaries))
			.length;
	};

	test("TC-5.45b 1,200 expired summaries all go, whatever the batching", async () => {
		await seedExpiredSummaries(1200);
		const result = await deleteExpiredSummaries(at(CUTOFF_MS), at(NOW.getTime() - LEASE_MS));
		expect(result).toEqual({ deleted: 1200, lockLost: false });
		expect(await count()).toBe(0);
	}, 60_000);

	describeSqliteOnly("P5-21 on SQLite", () => {
		test("TC-5.45c 1,200 rows are deleted in three batches of at most 500, and the event loop is let go between them", async () => {
			await seedExpiredSummaries(1200);
			const db = getDb() as unknown as { delete: (t: unknown) => unknown };
			const original = db.delete.bind(db);
			const { spyOn } = await import("bun:test");
			const spy = spyOn(db, "delete").mockImplementation((t: unknown) => original(t));
			let ticks = 0;
			const timer = setInterval(() => ticks++, 0);
			try {
				const result = await deleteExpiredSummaries(at(CUTOFF_MS), at(NOW.getTime() - LEASE_MS));
				expect(result.deleted).toBe(1200);
				expect(spy.mock.calls.length).toBe(3);
				expect(ticks).toBeGreaterThanOrEqual(2);
			} finally {
				clearInterval(timer);
				spy.mockRestore();
			}
		}, 60_000);
	});

	describePostgresOnly("P5-21 on Postgres", () => {
		test("TC-5.57b every batch is its own transaction that takes the lock: 1,200 rows are four transactions (three with rows, one empty)", async () => {
			await seedExpiredSummaries(1200);
			const wt = await import("../db/with-transaction.js");
			const { spyOn } = await import("bun:test");
			const real = wt.withTransaction;
			const spy = spyOn(wt, "withTransaction").mockImplementation(((fn: never) =>
				real(fn)) as typeof wt.withTransaction);
			try {
				const result = await deleteExpiredSummaries(at(CUTOFF_MS), at(NOW.getTime() - LEASE_MS));
				expect(result).toEqual({ deleted: 1200, lockLost: false });
				expect(spy.mock.calls.length).toBe(4);
			} finally {
				spy.mockRestore();
			}
		}, 60_000);

		test("TC-5.57c a pass that deleted its event batches and some summaries, then lost the lock, reports what it deleted and the skip", async () => {
			await upsertSetting("eventsRetentionDays", 30);
			_setRetentionBatchSizeForTest(1);
			await seedSummary("keep-a", { generatedAt: at(CUTOFF_MS - DAY), attemptStatus: "idle" });
			await seedSummary("keep-b", { generatedAt: at(CUTOFF_MS - DAY), attemptStatus: "idle" });
			await seedEvent("keep-a", at(CUTOFF_MS - DAY));
			await seedEvent("keep-a", at(CUTOFF_MS - DAY + 1000));
			const wt = await import("../db/with-transaction.js");
			const { spyOn } = await import("bun:test");
			const postgres = (await import("postgres")).default;
			const holder = postgres(config.databaseUrl, { max: 1 });
			const real = wt.withTransaction;
			let calls = 0;
			// Calls 1 to 3 are the event batches (1, 1, then empty); 4 and 5 are summary batches.
			// Another replica takes the lock just before the fifth.
			const spy = spyOn(wt, "withTransaction").mockImplementation((async (fn: never) => {
				calls++;
				if (calls === 5) await holder`SELECT pg_advisory_lock(${PG_RETENTION_LOCK_ID})`;
				return real(fn);
			}) as typeof wt.withTransaction);
			try {
				const result = await runRetentionPass(NOW);
				expect(result.rowsDeleted).toBe(2);
				expect(result.summariesDeleted).toBe(1);
				expect(result.skippedReason).toBe("lock_held_elsewhere");
				expect(await count()).toBe(1);
			} finally {
				spy.mockRestore();
				await holder`SELECT pg_advisory_unlock(${PG_RETENTION_LOCK_ID})`;
				await holder.end({ timeout: 2 });
			}
		}, 60_000);
	});
});

describe("the statements about what retention deletes are true (P5-23)", () => {
	const root = join(import.meta.dir, "../../..");
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	test("TC-5.45d the operator README, CLAUDE.md, the health comment and the CHANGELOG say summaries are deleted and name summariesDeleted; the old guarantee is gone", () => {
		const k8s = read("deploy/k8s/README.md");
		const claude = read("CLAUDE.md");
		const health = read("src/server/routes/health.ts");
		const changelog = read("CHANGELOG.md");
		for (const [name, text] of Object.entries({ k8s, claude, health, changelog })) {
			expect(text, name).toContain("summariesDeleted");
		}
		expect(k8s).not.toContain("only the `events` history ages out");
		expect(claude).not.toContain("Only `events` rows are deleted");
		expect(k8s).toMatch(/session summaries/i);
		expect(claude).toContain("ai_session_summaries");
	});
});
