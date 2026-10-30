/**
 * watcher_configs table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK.
 */
import { sql } from "drizzle-orm";
import { boolean, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionsPg } from "../core/sessions.js";
import { tsColumn } from "../factory.js";

export const watcherConfigsSqlite = sqliteTable("watcher_configs", {
	sessionId: text("session_id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	providerId: text("provider_id").notNull(),
	policy: text("policy").notNull().default("ask_always"),
	channelId: text("channel_id"),
	maxContinuations: integer("max_continuations").notNull().default(10),
	continuationsUsed: integer("continuations_used").notNull().default(0),
	maxDailyCents: integer("max_daily_cents"),
	systemPrompt: text("system_prompt"),
	// Two independent switches. Rows that predate them behave as Continue-only.
	notifyEnabled: integer("notify_enabled", { mode: "boolean" }).notNull().default(false),
	continueEnabled: integer("continue_enabled", { mode: "boolean" }).notNull().default(true),
	// Set only by a human confirming the `auto` policy; auto is honoured only while set.
	autoConfirmedAt: text("auto_confirmed_at"),
	autoConfirmedBy: text("auto_confirmed_by"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const watcherConfigsPg = pgTable("watcher_configs", {
	// Postgres: cascade FK on sessionId (Decision 7).
	sessionId: pgText("session_id")
		.primaryKey()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(false),
	providerId: pgText("provider_id").notNull(),
	policy: pgText("policy").notNull().default("ask_always"),
	channelId: pgText("channel_id"),
	maxContinuations: pgInteger("max_continuations").notNull().default(10),
	continuationsUsed: pgInteger("continuations_used").notNull().default(0),
	maxDailyCents: pgInteger("max_daily_cents"),
	systemPrompt: pgText("system_prompt"),
	notifyEnabled: boolean("notify_enabled").notNull().default(false),
	continueEnabled: boolean("continue_enabled").notNull().default(true),
	autoConfirmedAt: pgText("auto_confirmed_at"),
	autoConfirmedBy: pgText("auto_confirmed_by"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
