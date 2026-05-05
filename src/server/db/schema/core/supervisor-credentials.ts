/**
 * supervisor_credentials table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const supervisorCredentialsSqlite = sqliteTable("supervisor_credentials", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	supervisorId: text("supervisor_id").notNull().unique(),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	tokenPrefix: text("token_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	lastUsedAt: text("last_used_at"),
	revokedAt: text("revoked_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const supervisorCredentialsPg = pgTable("supervisor_credentials", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	supervisorId: pgText("supervisor_id").notNull().unique(),
	name: pgText("name").notNull(),
	tokenHash: pgText("token_hash").notNull().unique(),
	tokenPrefix: pgText("token_prefix").notNull(),
	isActive: boolean("is_active").notNull().default(true),
	lastUsedAt: pgText("last_used_at"),
	revokedAt: pgText("revoked_at"),
	createdAt: tsColumn("postgres", "created_at"),
});
