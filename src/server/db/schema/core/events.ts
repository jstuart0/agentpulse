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
import {
	boolean,
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

// dedupKey (AGEN-16 / Decision 2): server-derived durable identity for hook
// deliveries. Nullable — content-window-policy rows (transcript, status,
// managed, AI) never carry one. UNIQUE(session_id, dedup_key) backs
// ON CONFLICT DO NOTHING; NULL values never conflict with each other.
// idx_events_session_id_id backs every session-scoped `ORDER BY id DESC`
// read (Decision 15).
export const eventsSqlite = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId),
		eventType: text("event_type").notNull(),
		category: text("category"),
		source: text("source").notNull().default("observed_hook"),
		content: text("content"),
		isNoise: integer("is_noise", { mode: "boolean" }).notNull().default(false),
		// F244: UNTRUSTED, agent-supplied data (see provider_event_name in
		// src/shared/types.ts) — never splice raw into a log line, prompt, or
		// shell command.
		providerEventType: text("provider_event_type"),
		toolName: text("tool_name"),
		toolInput: jsonColumn<Record<string, unknown>>("sqlite", "tool_input"),
		toolResponse: text("tool_response"),
		rawPayload: jsonColumn<Record<string, unknown>>("sqlite", "raw_payload").notNull(),
		dedupKey: text("dedup_key"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		sessionIdIdx: index("idx_events_session_id_id").on(t.sessionId, t.id),
		sessionDedupKeyUniq: uniqueIndex("uq_events_session_dedup_key").on(t.sessionId, t.dedupKey),
	}),
);

export const eventsPg = pgTable(
	"events",
	{
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
		// F244: UNTRUSTED, agent-supplied data — see the sqlite table above.
		providerEventType: pgText("provider_event_type"),
		toolName: pgText("tool_name"),
		toolInput: jsonColumn<Record<string, unknown>>("postgres", "tool_input"),
		toolResponse: pgText("tool_response"),
		rawPayload: jsonColumn<Record<string, unknown>>("postgres", "raw_payload").notNull(),
		dedupKey: pgText("dedup_key"),
		createdAt: tsColumn("postgres", "created_at"),
	},
	(t) => ({
		sessionIdIdx: pgIndex("idx_events_session_id_id").on(t.sessionId, t.id),
		sessionDedupKeyUniq: pgUniqueIndex("uq_events_session_dedup_key").on(t.sessionId, t.dedupKey),
	}),
);
