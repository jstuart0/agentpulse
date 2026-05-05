/**
 * ask_threads table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
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

export const askThreadsPg = pgTable("ask_threads", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	title: pgText("title"),
	origin: pgText("origin").notNull().default("web"),
	telegramChatId: pgText("telegram_chat_id"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
	archivedAt: pgText("archived_at"),
});
