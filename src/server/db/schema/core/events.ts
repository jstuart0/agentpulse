/**
 * events table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: .references() present for Drizzle type fidelity; no onDelete —
 *           the cascade-FK rebuild in client.ts adds the CASCADE constraint at boot.
 *   Postgres: declared inline with onDelete: "cascade" (Decision 7).
 *
 * events.id: SQLite uses autoIncrement integer PK; Postgres uses
 * GENERATED ALWAYS AS IDENTITY (the only intIdColumn site in the schema).
 */
import { sql } from "drizzle-orm";
import { boolean, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn } from "../factory.js";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

export const eventsSqlite = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessionsSqlite.sessionId),
	eventType: text("event_type").notNull(),
	category: text("category"),
	source: text("source").notNull().default("observed_hook"),
	content: text("content"),
	isNoise: integer("is_noise", { mode: "boolean" }).notNull().default(false),
	providerEventType: text("provider_event_type"),
	toolName: text("tool_name"),
	toolInput: jsonColumn<Record<string, unknown>>("sqlite", "tool_input"),
	toolResponse: text("tool_response"),
	rawPayload: jsonColumn<Record<string, unknown>>("sqlite", "raw_payload").notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const eventsPg = pgTable("events", {
	// Postgres: GENERATED ALWAYS AS IDENTITY (intIdColumn equivalent).
	id: pgInteger("id").primaryKey().generatedAlwaysAsIdentity(),
	// Postgres: inline cascade FK (Decision 7).
	sessionId: pgText("session_id")
		.notNull()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	eventType: pgText("event_type").notNull(),
	category: pgText("category"),
	source: pgText("source").notNull().default("observed_hook"),
	content: pgText("content"),
	isNoise: boolean("is_noise").notNull().default(false),
	providerEventType: pgText("provider_event_type"),
	toolName: pgText("tool_name"),
	toolInput: jsonColumn<Record<string, unknown>>("postgres", "tool_input"),
	toolResponse: pgText("tool_response"),
	rawPayload: jsonColumn<Record<string, unknown>>("postgres", "raw_payload").notNull(),
	createdAt: pgText("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
