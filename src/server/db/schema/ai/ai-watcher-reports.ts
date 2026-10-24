import { sql } from "drizzle-orm";
/**
 * ai_watcher_reports table — dual-dialect (Decision 21 / Decision 22).
 * One Notify report per (session, turn). Born with its cascade FK on both
 * dialects, like ai_session_summaries, so the SQLite child-FK rebuild list is
 * not extended.
 *
 * The unique (session_id, turn_key) index is the dedupe: a turn is reported at
 * most once, and a restart or a second wake for the same turn finds the row.
 */
import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import { uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "../core/sessions.js";
import { jsonColumn, tsColumn } from "../factory.js";

export const aiWatcherReportsSqlite = sqliteTable(
	"ai_watcher_reports",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		turnKey: text("turn_key").notNull(),
		triggerEventId: integer("trigger_event_id"),
		throughEventId: integer("through_event_id"),
		verdict: text("verdict"),
		why: text("why"),
		evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>(),
		status: text("status").notNull().default("claimed"),
		failureCode: text("failure_code"),
		attemptCount: integer("attempt_count").notNull().default(1),
		claimedAt: text("claimed_at"),
		providerId: text("provider_id"),
		tokensIn: integer("tokens_in").notNull().default(0),
		tokensOut: integer("tokens_out").notNull().default(0),
		costCents: integer("cost_cents").notNull().default(0),
		telegramStatus: text("telegram_status"),
		telegramSentAt: text("telegram_sent_at"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		sessionTurn: uniqueIndex("uq_ai_watcher_reports_session_turn").on(t.sessionId, t.turnKey),
		sessionCreated: index("idx_ai_watcher_reports_session_created").on(t.sessionId, t.createdAt),
		telegramSent: index("idx_ai_watcher_reports_telegram_sent").on(t.telegramSentAt),
	}),
);

export const aiWatcherReportsPg = pgTable(
	"ai_watcher_reports",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		turnKey: pgText("turn_key").notNull(),
		triggerEventId: pgInteger("trigger_event_id"),
		throughEventId: pgInteger("through_event_id"),
		verdict: pgText("verdict"),
		why: pgText("why"),
		evidenceIds: jsonColumn<string[]>("postgres", "evidence_ids"),
		status: pgText("status").notNull().default("claimed"),
		failureCode: pgText("failure_code"),
		attemptCount: pgInteger("attempt_count").notNull().default(1),
		claimedAt: pgText("claimed_at"),
		providerId: pgText("provider_id"),
		tokensIn: pgInteger("tokens_in").notNull().default(0),
		tokensOut: pgInteger("tokens_out").notNull().default(0),
		costCents: pgInteger("cost_cents").notNull().default(0),
		telegramStatus: pgText("telegram_status"),
		telegramSentAt: pgText("telegram_sent_at"),
		createdAt: tsColumn("postgres", "created_at"),
	},
	(t) => ({
		sessionTurn: pgUniqueIndex("uq_ai_watcher_reports_session_turn").on(t.sessionId, t.turnKey),
		sessionCreated: pgIndex("idx_ai_watcher_reports_session_created").on(t.sessionId, t.createdAt),
		telegramSent: pgIndex("idx_ai_watcher_reports_telegram_sent").on(t.telegramSentAt),
	}),
);
