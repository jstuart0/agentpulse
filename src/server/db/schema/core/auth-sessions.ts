/**
 * auth_sessions table — dual-dialect (Decision 21 / Decision 22).
 * Active local-auth sessions. Primary key is the hash of the session token.
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const authSessionsSqlite = sqliteTable("auth_sessions", {
	tokenHash: text("token_hash").primaryKey(),
	userId: text("user_id").notNull(),
	expiresAt: text("expires_at").notNull(),
	userAgent: text("user_agent"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	lastSeenAt: text("last_seen_at").notNull().default(sql`(datetime('now'))`),
});

export const authSessionsPg = pgTable("auth_sessions", {
	tokenHash: pgText("token_hash").primaryKey(),
	userId: pgText("user_id").notNull(),
	expiresAt: pgText("expires_at").notNull(),
	userAgent: pgText("user_agent"),
	createdAt: tsColumn("postgres", "created_at"),
	lastSeenAt: tsColumn("postgres", "last_seen_at"),
});
