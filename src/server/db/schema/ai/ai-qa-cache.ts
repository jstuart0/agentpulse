/**
 * ai_qa_cache table — dual-dialect (Decision 21 / Decision 22).
 * Per-(session, question-hash) response cache for per-session Q&A Ask intent.
 */
import { sql } from "drizzle-orm";
import {
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const aiQaCacheSqlite = sqliteTable(
	"ai_qa_cache",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id").notNull(),
		questionHash: text("question_hash").notNull(),
		response: text("response").notNull(),
		lastEventId: integer("last_event_id").notNull(),
		cachedAt: text("cached_at").notNull().default(sql`(datetime('now'))`),
		expiresAt: text("expires_at").notNull(),
	},
	(t) => ({
		uniq: uniqueIndex("idx_qa_cache_session_question").on(t.sessionId, t.questionHash),
	}),
);

export const aiQaCachePg = pgTable(
	"ai_qa_cache",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: pgText("session_id").notNull(),
		questionHash: pgText("question_hash").notNull(),
		response: pgText("response").notNull(),
		lastEventId: pgInteger("last_event_id").notNull(),
		cachedAt: tsColumn("postgres", "cached_at"),
		expiresAt: pgText("expires_at").notNull(),
	},
	(t) => ({
		uniq: pgUniqueIndex("idx_qa_cache_session_question").on(t.sessionId, t.questionHash),
	}),
);
