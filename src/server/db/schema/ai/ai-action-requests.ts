/**
 * ai_action_requests table — dual-dialect (Decision 21 / Decision 22).
 * Operator-approval queue for AI-initiated actions that are NOT session-scoped.
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const aiActionRequestsSqlite = sqliteTable("ai_action_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text("kind").notNull(),
	status: text("status").notNull().default("awaiting_reply"),
	failureReason: text("failure_reason"),
	question: text("question").notNull(),
	payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
	origin: text("origin").notNull(),
	channelId: text("channel_id"),
	askThreadId: text("ask_thread_id"),
	resolvedAt: text("resolved_at"),
	resolvedBy: text("resolved_by"),
	resultEventId: text("result_event_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const aiActionRequestsPg = pgTable("ai_action_requests", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: pgText("kind").notNull(),
	status: pgText("status").notNull().default("awaiting_reply"),
	failureReason: pgText("failure_reason"),
	question: pgText("question").notNull(),
	payload: jsonColumn<Record<string, unknown>>("postgres", "payload").notNull(),
	origin: pgText("origin").notNull(),
	channelId: pgText("channel_id"),
	askThreadId: pgText("ask_thread_id"),
	resolvedAt: pgText("resolved_at"),
	resolvedBy: pgText("resolved_by"),
	resultEventId: pgText("result_event_id"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
