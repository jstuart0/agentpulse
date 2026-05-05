/**
 * ask_messages table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const askMessagesSqlite = sqliteTable("ask_messages", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	threadId: text("thread_id").notNull(),
	role: text("role").notNull(),
	content: text("content").notNull(),
	contextSessionIds: jsonColumn<string[]>("sqlite", "context_session_ids"),
	tokensIn: integer("tokens_in"),
	tokensOut: integer("tokens_out"),
	errorMessage: text("error_message"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const askMessagesPg = pgTable("ask_messages", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	threadId: pgText("thread_id").notNull(),
	role: pgText("role").notNull(),
	content: pgText("content").notNull(),
	contextSessionIds: jsonColumn<string[]>("postgres", "context_session_ids"),
	tokensIn: pgInteger("tokens_in"),
	tokensOut: pgInteger("tokens_out"),
	errorMessage: pgText("error_message"),
	createdAt: tsColumn("postgres", "created_at"),
});
