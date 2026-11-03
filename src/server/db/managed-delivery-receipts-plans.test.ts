/**
 * AGEN-83: the receipts table at the volume it reaches on a busy host (up to millions of rows
 * in 72 h). Every managed events delivery with an id does one INSERT ... ON CONFLICT on
 * (session_id, receipt_key), and every retention tick selects the oldest expired batch. Both must
 * be index lookups at 100k+ rows with statistics, never a scan.
 *
 * The conflict check itself is an INSERT, which EXPLAINs as a plain insert, so a SELECT on the
 * same two columns stands in for it: the planner reaches the same unique index. The prune's batch
 * select is the exact statement the retention service runs (expiredReceiptBatchQuery).
 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import "../services/ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { and, eq, sql } = await import("drizzle-orm");
const { getDb, getSqlite, initializeDatabase } = await import("./client.js");
const { managedDeliveryReceipts, sessions } = await import("./schema/index.js");
const { seedReceipts } = await import("../test-utils/receipt-fixtures.js");
const { expiredReceiptBatchQuery } = await import("../services/retention-service.js");

const TOTAL = 120_000;
const PREFIX = "plan-r-";

beforeAll(() => initializeDatabase());

afterEach(async () => {
	await getDb().delete(managedDeliveryReceipts);
	await getDb().delete(sessions);
});

const seed = () =>
	seedReceipts({
		sessionPrefix: PREFIX,
		sessions: 50,
		total: TOTAL,
		expiredEvery: 20,
		expiredAt: "2026-10-01 00:00:00",
		freshAt: "2026-11-01 12:00:00",
	});

const lookup = () =>
	getDb()
		.select({ id: managedDeliveryReceipts.id })
		.from(managedDeliveryReceipts)
		.where(
			and(
				eq(managedDeliveryReceipts.sessionId, `${PREFIX}7`),
				eq(managedDeliveryReceipts.receiptKey, "00000000000000000000000000000007"),
			),
		)
		.toSQL();

const prune = () => expiredReceiptBatchQuery(getDb(), "2026-10-29 00:00:00", 1000).toSQL();

describeSqliteOnly("receipts plans — SQLite", () => {
	const plan = (q: { sql: string; params: unknown[] }) =>
		(
			getSqlite()
				.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
				.all(...(q.params as never[])) as Array<{ detail: string }>
		)
			.map((r) => r.detail)
			.join("\n");

	test("the seed is at least 100k rows, some expired and most fresh (the fixture means something)", async () => {
		await seed();
		const [row] = getSqlite()
			.prepare(
				"SELECT COUNT(*) AS n, SUM(created_at < '2026-10-29') AS old FROM managed_delivery_receipts",
			)
			.all() as Array<{ n: number; old: number }>;
		expect(row?.n).toBe(TOTAL);
		expect(row?.old).toBe(TOTAL / 20);
	}, 60_000);

	test("the conflict-check lookup searches the unique (session_id, receipt_key) index; the prune batch walks the created_at index with no sort", async () => {
		await seed();
		getSqlite().exec("ANALYZE");
		const lookupPlan = plan(lookup());
		expect(lookupPlan, lookupPlan).toContain("uq_managed_delivery_receipts_session_key");
		expect(lookupPlan, lookupPlan).toMatch(/SEARCH/);
		expect(lookupPlan, lookupPlan).not.toMatch(/\bSCAN\b/);
		const prunePlan = plan(prune());
		expect(prunePlan, prunePlan).toContain("idx_managed_delivery_receipts_created_at");
		expect(prunePlan, prunePlan).not.toMatch(/\bSCAN managed_delivery_receipts\b(?! USING)/);
		expect(prunePlan, prunePlan).not.toContain("TEMP B-TREE");
	}, 60_000);
});

describePostgresOnly("receipts plans — Postgres", () => {
	const planOf = async (q: { sql: string; params: unknown[] }) => {
		const client = (
			getDb() as unknown as {
				$client: { unsafe: (text: string, params: unknown[], options: object) => Promise<unknown> };
			}
		).$client;
		const rows = (await client.unsafe(`EXPLAIN (COSTS OFF) ${q.sql}`, q.params, {
			prepare: false,
		})) as Array<Record<string, string>>;
		return rows.map((r) => r["QUERY PLAN"]).join("\n");
	};

	test("the conflict-check lookup uses the unique index; the prune batch uses the created_at index with no sort", async () => {
		await seed();
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		await db.execute(sql`ANALYZE managed_delivery_receipts`);
		const lookupPlan = await planOf(lookup());
		expect(lookupPlan, lookupPlan).toContain("uq_managed_delivery_receipts_session_key");
		expect(lookupPlan, lookupPlan).not.toContain("Seq Scan");
		const prunePlan = await planOf(prune());
		expect(prunePlan, prunePlan).toContain("idx_managed_delivery_receipts_created_at");
		expect(prunePlan, prunePlan).not.toContain("Seq Scan");
		expect(prunePlan, prunePlan).not.toMatch(/\bSort\b/);
	}, 120_000);
});
