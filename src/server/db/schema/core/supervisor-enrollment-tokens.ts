/**
 * supervisor_enrollment_tokens table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const supervisorEnrollmentTokensSqlite = sqliteTable("supervisor_enrollment_tokens", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	supervisorId: text("supervisor_id"),
	tokenHash: text("token_hash").notNull().unique(),
	tokenPrefix: text("token_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	expiresAt: text("expires_at"),
	usedAt: text("used_at"),
	revokedAt: text("revoked_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const supervisorEnrollmentTokensPg = pgTable("supervisor_enrollment_tokens", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: pgText("name").notNull(),
	supervisorId: pgText("supervisor_id"),
	tokenHash: pgText("token_hash").notNull().unique(),
	tokenPrefix: pgText("token_prefix").notNull(),
	isActive: boolean("is_active").notNull().default(true),
	expiresAt: pgText("expires_at"),
	usedAt: pgText("used_at"),
	revokedAt: pgText("revoked_at"),
	createdAt: tsColumn("postgres", "created_at"),
});
