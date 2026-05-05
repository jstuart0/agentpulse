/**
 * watcher_proposals table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK.
 */
import { sql } from "drizzle-orm";
import { boolean, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import { sessionsPg } from "../core/sessions.js";

export const watcherProposalsSqlite = sqliteTable("watcher_proposals", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull(),
	providerId: text("provider_id").notNull(),
	state: text("state").notNull().default("pending"),
	decision: text("decision"),
	nextPrompt: text("next_prompt"),
	reportSummary: text("report_summary"),
	rawResponse: text("raw_response_json", { mode: "json" }).$type<Record<string, unknown>>(),
	triggerEventId: text("trigger_event_id"),
	tokensIn: integer("tokens_in").notNull().default(0),
	tokensOut: integer("tokens_out").notNull().default(0),
	costCents: integer("cost_cents").notNull().default(0),
	usageEstimated: integer("usage_estimated", { mode: "boolean" }).notNull().default(false),
	errorSubType: text("error_sub_type"),
	errorMessage: text("error_message"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const watcherProposalsPg = pgTable("watcher_proposals", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	// Postgres: cascade FK (Decision 7).
	sessionId: pgText("session_id")
		.notNull()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	providerId: pgText("provider_id").notNull(),
	state: pgText("state").notNull().default("pending"),
	decision: pgText("decision"),
	nextPrompt: pgText("next_prompt"),
	reportSummary: pgText("report_summary"),
	rawResponse: jsonColumn<Record<string, unknown>>("postgres", "raw_response_json"),
	triggerEventId: pgText("trigger_event_id"),
	tokensIn: pgInteger("tokens_in").notNull().default(0),
	tokensOut: pgInteger("tokens_out").notNull().default(0),
	costCents: pgInteger("cost_cents").notNull().default(0),
	usageEstimated: boolean("usage_estimated").notNull().default(false),
	errorSubType: pgText("error_sub_type"),
	errorMessage: pgText("error_message"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
