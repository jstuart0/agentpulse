/**
 * ai_session_summaries table — dual-dialect (Decision 21 / Decision 22).
 * The latest AI summary of one session, plus the state of the attempt that is
 * producing or last failed to produce the next one. One row per session.
 *
 * Cascade FK on session_id, declared inline on BOTH dialects. This departs
 * from the convention above (SQLite child tables carry no FK here and get it
 * from rebuildSessionChildFks): a table born with its FK needs no rebuild, so
 * that list is deliberately not extended.
 *
 * Column order is load-bearing: the small columns the retention scan reads
 * (generated_at, attempt_status, through_event_id, attempt_started_at) come
 * before the two JSON columns, so the scan does not walk overflow pages. The
 * same order is held by both migrations and by the legacy DDL in client.ts.
 */
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { SessionSummary, SummaryProvenance } from "../../../../shared/session-summary.js";
import { sessionsPg, sessionsSqlite } from "../core/sessions.js";
import { jsonColumn } from "../factory.js";

export const aiSessionSummariesSqlite = sqliteTable("ai_session_summaries", {
	sessionId: text("session_id")
		.primaryKey()
		.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
	schemaVersion: integer("schema_version").notNull().default(1),
	generatedAt: text("generated_at"),
	attemptStatus: text("attempt_status").notNull().default("idle"),
	throughEventId: integer("through_event_id"),
	attemptStartedAt: text("attempt_started_at"),
	attemptToken: text("attempt_token"),
	attemptErrorCode: text("attempt_error_code"),
	summary: text("summary", { mode: "json" }).$type<SessionSummary>(),
	provenance: text("provenance", { mode: "json" }).$type<SummaryProvenance>(),
});

export const aiSessionSummariesPg = pgTable("ai_session_summaries", {
	sessionId: pgText("session_id")
		.primaryKey()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	schemaVersion: pgInteger("schema_version").notNull().default(1),
	generatedAt: pgText("generated_at"),
	attemptStatus: pgText("attempt_status").notNull().default("idle"),
	throughEventId: pgInteger("through_event_id"),
	attemptStartedAt: pgText("attempt_started_at"),
	attemptToken: pgText("attempt_token"),
	attemptErrorCode: pgText("attempt_error_code"),
	summary: jsonColumn<SessionSummary>("postgres", "summary"),
	provenance: jsonColumn<SummaryProvenance>("postgres", "provenance"),
});
