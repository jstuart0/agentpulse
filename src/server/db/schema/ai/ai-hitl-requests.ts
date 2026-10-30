/**
 * ai_hitl_requests table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK.
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
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionsPg } from "../core/sessions.js";
import { tsColumn } from "../factory.js";

export const aiHitlRequestsSqlite = sqliteTable("ai_hitl_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	proposalId: text("proposal_id").notNull(),
	sessionId: text("session_id").notNull(),
	channelId: text("channel_id"),
	status: text("status").notNull().default("awaiting_reply"),
	replyKind: text("reply_kind"),
	replyText: text("reply_text"),
	expiresAt: text("expires_at"),
	// What a decision on this request is bound to: the turn, the event that
	// triggered it, the hash of the prompt a human is shown, whether that
	// prompt is approvable as stored, and when a Telegram copy was sent.
	turnKey: text("turn_key"),
	triggerEventId: integer("trigger_event_id"),
	promptSha256: text("prompt_sha256"),
	approvable: integer("approvable", { mode: "boolean" }),
	telegramSentAt: text("telegram_sent_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const aiHitlRequestsPg = pgTable(
	"ai_hitl_requests",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		proposalId: pgText("proposal_id").notNull(),
		// Postgres: cascade FK (Decision 7).
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		channelId: pgText("channel_id"),
		status: pgText("status").notNull().default("awaiting_reply"),
		replyKind: pgText("reply_kind"),
		replyText: pgText("reply_text"),
		expiresAt: pgText("expires_at"),
		turnKey: pgText("turn_key"),
		triggerEventId: pgInteger("trigger_event_id"),
		promptSha256: pgText("prompt_sha256"),
		approvable: boolean("approvable"),
		telegramSentAt: pgText("telegram_sent_at"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
	},
	(t) => ({
		// Composite index: fast lookup by session + status (matches SQLite DDL).
		sessionStatus: pgIndex("idx_ai_hitl_requests_session_status").on(t.sessionId, t.status),
		// Partial unique: only one open HITL request per session at a time (security invariant).
		openPerSession: pgUniqueIndex("idx_ai_hitl_requests_open_per_session")
			.on(t.sessionId)
			.where(sql`${t.status} = 'awaiting_reply'`),
	}),
);
