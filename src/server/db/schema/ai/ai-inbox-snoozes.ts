/**
 * ai_inbox_snoozes table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const aiInboxSnoozesSqlite = sqliteTable("ai_inbox_snoozes", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text("kind").notNull(),
	targetId: text("target_id").notNull(),
	snoozedUntil: text("snoozed_until").notNull(),
	createdBy: text("created_by"),
	reason: text("reason"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const aiInboxSnoozesPg = pgTable("ai_inbox_snoozes", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: pgText("kind").notNull(),
	targetId: pgText("target_id").notNull(),
	snoozedUntil: pgText("snoozed_until").notNull(),
	createdBy: pgText("created_by"),
	reason: pgText("reason"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
