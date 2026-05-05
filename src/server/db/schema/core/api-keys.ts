/**
 * api_keys table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const apiKeysSqlite = sqliteTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	keyHash: text("key_hash").notNull().unique(),
	keyPrefix: text("key_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	lastUsedAt: text("last_used_at"),
});

export const apiKeysPg = pgTable("api_keys", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: pgText("name").notNull(),
	keyHash: pgText("key_hash").notNull().unique(),
	keyPrefix: pgText("key_prefix").notNull(),
	isActive: boolean("is_active").notNull().default(true),
	createdAt: tsColumn("postgres", "created_at"),
	lastUsedAt: pgText("last_used_at"),
});
