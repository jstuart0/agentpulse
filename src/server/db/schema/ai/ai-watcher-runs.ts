/**
 * ai_watcher_runs table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK.
 */
import { sql } from "drizzle-orm";
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionsPg } from "../core/sessions.js";
import { tsColumn } from "../factory.js";

export const aiWatcherRunsSqlite = sqliteTable("ai_watcher_runs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull(),
	triggerEventId: integer("trigger_event_id"),
	triggerKind: text("trigger_kind").notNull(),
	status: text("status").notNull().default("queued"),
	dedupeKey: text("dedupe_key").notNull(),
	leaseOwner: text("lease_owner"),
	leaseExpiresAt: text("lease_expires_at"),
	attemptCount: integer("attempt_count").notNull().default(0),
	lastErrorSubType: text("last_error_sub_type"),
	claimedAt: text("claimed_at"),
	completedAt: text("completed_at"),
	proposalId: text("proposal_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const aiWatcherRunsPg = pgTable("ai_watcher_runs", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	// Postgres: cascade FK (Decision 7).
	sessionId: pgText("session_id")
		.notNull()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	triggerEventId: pgInteger("trigger_event_id"),
	triggerKind: pgText("trigger_kind").notNull(),
	status: pgText("status").notNull().default("queued"),
	dedupeKey: pgText("dedupe_key").notNull(),
	leaseOwner: pgText("lease_owner"),
	leaseExpiresAt: pgText("lease_expires_at"),
	attemptCount: pgInteger("attempt_count").notNull().default(0),
	lastErrorSubType: pgText("last_error_sub_type"),
	claimedAt: pgText("claimed_at"),
	completedAt: pgText("completed_at"),
	proposalId: pgText("proposal_id"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
