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
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const askThreadsSqlite = sqliteTable(
	"ask_threads",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		title: text("title"),
		origin: text("origin").notNull().default("web"),
		telegramChatId: text("telegram_chat_id"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
		archivedAt: text("archived_at"),
		/** Who asked: the signed-in user, or an owned key's owner. Null for a thread that predates owners and for a key with no owner. */
		ownerUserId: text("owner_user_id"),
		/** The API key that asked, for a key with no owner user. Null otherwise. */
		ownerKeyId: text("owner_key_id"),
	},
	(t) => ({
		// A member's own active threads, newest first (the Ask list), and an ownerless key's.
		ownerUserActive: index("idx_ask_threads_owner_user")
			.on(t.ownerUserId, sql`${t.updatedAt} desc`)
			.where(sql`${t.archivedAt} IS NULL`),
		ownerKeyActive: index("idx_ask_threads_owner_key")
			.on(t.ownerKeyId, sql`${t.updatedAt} desc`)
			.where(sql`${t.archivedAt} IS NULL AND ${t.ownerUserId} IS NULL`),
	}),
);

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
		ownerUserId: pgText("owner_user_id"),
		ownerKeyId: pgText("owner_key_id"),
	},
	(t) => ({
		// Partial index: fast recent-thread scan for active (non-archived) threads.
		updatedActive: pgIndex("idx_ask_threads_updated")
			.on(t.updatedAt)
			.where(sql`${t.archivedAt} IS NULL`),
		// Partial unique: one active thread per Telegram chat (NULL chat_id rows are excluded).
		ownerUserActive: pgIndex("idx_ask_threads_owner_user")
			.on(t.ownerUserId, sql`${t.updatedAt} desc`)
			.where(sql`${t.archivedAt} IS NULL`),
		ownerKeyActive: pgIndex("idx_ask_threads_owner_key")
			.on(t.ownerKeyId, sql`${t.updatedAt} desc`)
			.where(sql`${t.archivedAt} IS NULL AND ${t.ownerUserId} IS NULL`),
		telegramChat: pgUniqueIndex("idx_ask_threads_telegram_chat")
			.on(t.telegramChatId)
			.where(sql`${t.telegramChatId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
	}),
);
