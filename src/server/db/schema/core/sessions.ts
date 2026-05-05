/**
 * sessions table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const sessionsSqlite = sqliteTable("sessions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull().unique(),
	displayName: text("display_name"),
	agentType: text("agent_type").notNull(),
	status: text("status").notNull().default("active"),
	cwd: text("cwd"),
	transcriptPath: text("transcript_path"),
	model: text("model"),
	startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
	lastActivityAt: text("last_activity_at").notNull().default(sql`(datetime('now'))`),
	endedAt: text("ended_at"),
	semanticStatus: text("semantic_status"),
	currentTask: text("current_task"),
	planSummary: jsonColumn<string[]>("sqlite", "plan_summary"),
	totalToolUses: integer("total_tool_uses").notNull().default(0),
	isWorking: integer("is_working", { mode: "boolean" }).notNull().default(false),
	isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
	gitBranch: text("git_branch"),
	claudeMdContent: text("claude_md_content"),
	claudeMdPath: text("claude_md_path"),
	claudeMdChecksum: text("claude_md_checksum"),
	claudeMdUpdatedAt: text("claude_md_updated_at"),
	notes: text("notes").default(""),
	metadata: jsonColumn<Record<string, unknown>>("sqlite", "metadata"),
	projectId: text("project_id"),
	isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
	watcherState: text("watcher_state"),
	watcherLastRunAt: text("watcher_last_run_at"),
	watcherLastUserPromptAt: text("watcher_last_user_prompt_at"),
	aiSpendCents: integer("ai_spend_cents").notNull().default(0),
});

export const sessionsPg = pgTable("sessions", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: pgText("session_id").notNull().unique(),
	displayName: pgText("display_name"),
	agentType: pgText("agent_type").notNull(),
	status: pgText("status").notNull().default("active"),
	cwd: pgText("cwd"),
	transcriptPath: pgText("transcript_path"),
	model: pgText("model"),
	startedAt: tsColumn("postgres", "started_at"),
	lastActivityAt: tsColumn("postgres", "last_activity_at"),
	endedAt: pgText("ended_at"),
	semanticStatus: pgText("semantic_status"),
	currentTask: pgText("current_task"),
	planSummary: jsonColumn<string[]>("postgres", "plan_summary"),
	totalToolUses: pgInteger("total_tool_uses").notNull().default(0),
	isWorking: boolean("is_working").notNull().default(false),
	isPinned: boolean("is_pinned").notNull().default(false),
	gitBranch: pgText("git_branch"),
	claudeMdContent: pgText("claude_md_content"),
	claudeMdPath: pgText("claude_md_path"),
	claudeMdChecksum: pgText("claude_md_checksum"),
	claudeMdUpdatedAt: pgText("claude_md_updated_at"),
	notes: pgText("notes").default(""),
	metadata: jsonColumn<Record<string, unknown>>("postgres", "metadata"),
	projectId: pgText("project_id"),
	isArchived: boolean("is_archived").notNull().default(false),
	watcherState: pgText("watcher_state"),
	watcherLastRunAt: pgText("watcher_last_run_at"),
	watcherLastUserPromptAt: pgText("watcher_last_user_prompt_at"),
	aiSpendCents: pgInteger("ai_spend_cents").notNull().default(0),
});
