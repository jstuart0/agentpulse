/**
 * Bulk-seeds managed_delivery_receipts in one statement, for the plan test and the retention
 * volume test. Raw SQL: 100,000 rows through the query builder would be slow and would not
 * exercise the table the way a long-running install fills it.
 */
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { getDb } from "../db/client.js";

export interface ReceiptSeed {
	/** Sessions created as `<prefix>0` .. `<prefix>(n-1)`; receipts are spread across them. */
	sessionPrefix: string;
	sessions: number;
	total: number;
	/** Every `expiredEvery`th receipt gets `expiredAt`; the rest get `freshAt`. 0 = none expired. */
	expiredEvery: number;
	expiredAt: string;
	freshAt: string;
}

export async function seedReceipts(seed: ReceiptSeed): Promise<void> {
	const { sessionPrefix, sessions, total, expiredEvery, expiredAt, freshAt } = seed;
	const every = expiredEvery > 0 ? expiredEvery : total + 1;
	if (config.dialect === "postgres") {
		const db = getDb() as unknown as { execute: (q: unknown) => Promise<unknown> };
		await db.execute(sql`INSERT INTO sessions (id, session_id, agent_type, status)
			SELECT gen_random_uuid(), ${sessionPrefix} || g, 'claude_code', 'active'
			FROM generate_series(0, ${sessions - 1}) g`);
		await db.execute(sql`INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at)
			SELECT ${sessionPrefix} || (g % ${sessions}), lpad(to_hex(g), 32, '0'),
				CASE WHEN g % ${every} = 0 THEN ${expiredAt} ELSE ${freshAt} END
			FROM generate_series(1, ${total}) g`);
		return;
	}
	const db = getDb();
	db.run(sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${sessions - 1})
		INSERT INTO sessions (id, session_id, agent_type, status)
		SELECT lower(hex(randomblob(16))), ${sessionPrefix} || i, 'claude_code', 'active' FROM n`);
	db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
		INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at)
		SELECT ${sessionPrefix} || (i % ${sessions}), printf('%032x', i),
			CASE WHEN i % ${every} = 0 THEN ${expiredAt} ELSE ${freshAt} END
		FROM n`);
}
