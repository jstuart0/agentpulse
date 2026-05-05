/**
 * notification_channels table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const notificationChannelsSqlite = sqliteTable("notification_channels", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: text("user_id").notNull().default("local"),
	kind: text("kind").notNull(),
	label: text("label").notNull(),
	credentialCiphertext: text("credential_ciphertext"),
	config: text("config_json", { mode: "json" }).$type<Record<string, unknown>>(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	verifiedAt: text("verified_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const notificationChannelsPg = pgTable("notification_channels", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: pgText("user_id").notNull().default("local"),
	kind: pgText("kind").notNull(),
	label: pgText("label").notNull(),
	credentialCiphertext: pgText("credential_ciphertext"),
	config: jsonColumn<Record<string, unknown>>("postgres", "config_json"),
	isActive: boolean("is_active").notNull().default(true),
	verifiedAt: pgText("verified_at"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
