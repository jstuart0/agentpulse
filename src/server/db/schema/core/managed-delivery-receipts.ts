/**
 * managed_delivery_receipts table — dual-dialect.
 *
 * One row per accepted delivery of a supervisor's managed events batch that
 * carried an `X-AgentPulse-Delivery-Id`. It is written in the same transaction
 * as the events insert, so a replay of a delivery whose rows were dropped by
 * the content window, or later pruned, is still recognised as a replay.
 *
 * `receipt_key` is the first 32 hex of a sha256 over the length-prefixed
 * [supervisorId, deliveryId, bodyDigest]. `created_at` is written by the insert
 * (`toDbTimestamp`, never a database default) so the prune's lexicographic
 * compare matches event retention's.
 *
 * Cascade FK on session_id, declared inline on BOTH dialects: the table is born
 * with its FK, so it is deliberately not in the legacy `rebuildSessionChildFks`
 * list (same as ai_session_summaries).
 */
import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

export const managedDeliveryReceiptsSqlite = sqliteTable(
	"managed_delivery_receipts",
	{
		id: integer("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		receiptKey: text("receipt_key").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => ({
		sessionReceiptUniq: uniqueIndex("uq_managed_delivery_receipts_session_key").on(
			t.sessionId,
			t.receiptKey,
		),
		createdAtIdx: index("idx_managed_delivery_receipts_created_at").on(t.createdAt),
	}),
);

export const managedDeliveryReceiptsPg = pgTable(
	"managed_delivery_receipts",
	{
		id: pgInteger("id").primaryKey().generatedAlwaysAsIdentity(),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		receiptKey: pgText("receipt_key").notNull(),
		createdAt: pgText("created_at").notNull(),
	},
	(t) => ({
		sessionReceiptUniq: pgUniqueIndex("uq_managed_delivery_receipts_session_key").on(
			t.sessionId,
			t.receiptKey,
		),
		createdAtIdx: pgIndex("idx_managed_delivery_receipts_created_at").on(t.createdAt),
	}),
);
