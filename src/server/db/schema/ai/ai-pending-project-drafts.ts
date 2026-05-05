/**
 * ai_pending_project_drafts table — dual-dialect (Decision 21 / Decision 22).
 * In-flight multi-turn state for add-project and launch-disambiguation flows.
 */
import { sql } from "drizzle-orm";
import { index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import type {
	LaunchDisambiguationDraftFields,
	NextQuestion,
	ProjectDraftFields,
} from "../types.js";

export const aiPendingProjectDraftsSqlite = sqliteTable("ai_pending_project_drafts", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	askThreadId: text("ask_thread_id").notNull(),
	channelId: text("channel_id"),
	origin: text("origin").notNull(),
	kind: text("kind").notNull().default("add_project"),
	draftFields: text("draft_fields", { mode: "json" })
		.$type<ProjectDraftFields | LaunchDisambiguationDraftFields>()
		.notNull(),
	nextQuestion: text("next_question", { mode: "json" }).$type<NextQuestion>().notNull(),
	status: text("status").notNull().default("drafting"),
	actionRequestId: text("action_request_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const aiPendingProjectDraftsPg = pgTable(
	"ai_pending_project_drafts",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		askThreadId: pgText("ask_thread_id").notNull(),
		channelId: pgText("channel_id"),
		origin: pgText("origin").notNull(),
		kind: pgText("kind").notNull().default("add_project"),
		draftFields: jsonColumn<ProjectDraftFields | LaunchDisambiguationDraftFields>(
			"postgres",
			"draft_fields",
		).notNull(),
		nextQuestion: jsonColumn<NextQuestion>("postgres", "next_question").notNull(),
		status: pgText("status").notNull().default("drafting"),
		actionRequestId: pgText("action_request_id"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
	},
	(t) => ({
		// Partial index: fast lookup of in-flight drafts for a thread (completed rows excluded).
		threadInFlight: pgIndex("idx_pending_project_drafts_thread")
			.on(t.askThreadId, t.status)
			.where(sql`${t.status} IN ('drafting', 'pending_approval')`),
	}),
);
