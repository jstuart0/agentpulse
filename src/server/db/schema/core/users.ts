/**
 * users table — dual-dialect (Decision 21 / Decision 22).
 * Local accounts: username + argon2id password hash + optional role.
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const usersSqlite = sqliteTable("users", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	username: text("username").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	role: text("role").notNull().default("user"),
	disabledAt: text("disabled_at"),
	lastLoginAt: text("last_login_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const usersPg = pgTable("users", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	username: pgText("username").notNull().unique(),
	passwordHash: pgText("password_hash").notNull(),
	role: pgText("role").notNull().default("user"),
	disabledAt: pgText("disabled_at"),
	lastLoginAt: pgText("last_login_at"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
