/**
 * ask_threads table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import {
	index as pgIndex,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const askThreadsSqlite = sqliteTable("ask_threads", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	title: text("title"),
	origin: text("origin").notNull().default("web"),
	telegramChatId: text("telegram_chat_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	archivedAt: text("archived_at"),
});

export const askThreadsPg = pgTable(
	"ask_threads",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		title: pgText("title"),
		origin: pgText("origin").notNull().default("web"),
		telegramChatId: pgText("telegram_chat_id"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
		archivedAt: pgText("archived_at"),
	},
	(t) => ({
		// Partial index: fast recent-thread scan for active (non-archived) threads.
		updatedActive: pgIndex("idx_ask_threads_updated")
			.on(t.updatedAt)
			.where(sql`${t.archivedAt} IS NULL`),
		// Partial unique: one active thread per Telegram chat (NULL chat_id rows are excluded).
		telegramChat: pgUniqueIndex("idx_ask_threads_telegram_chat")
			.on(t.telegramChatId)
			.where(sql`${t.telegramChatId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
	}),
);
