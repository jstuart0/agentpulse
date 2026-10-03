/**
 * sessions table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

// F128: serves `WHERE agent_type = ? ORDER BY last_activity_at DESC` (the
// relay's per-tick Codex paging) without a temp B-tree sort. Both engines scan
// the ascending index backward for DESC. The legacy SQLite init path declares
// the same index in client.ts.
const AGENT_TYPE_LAST_ACTIVITY_INDEX = "idx_sessions_agent_type_last_activity";
// Serves the owner-scoped list/stats query. Both engines scan this for
// `WHERE owner_user_id = ? ORDER BY last_activity_at DESC`.
const OWNER_LAST_ACTIVITY_INDEX = "idx_sessions_owner_last_activity";

export const sessionsSqlite = sqliteTable(
	"sessions",
	{
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
		/** User owner. Null = unassigned, or service-key-owned (see ingestKeyId). Set once at creation; ingest never changes a non-null owner. */
		ownerUserId: text("owner_user_id"),
		/** The key that posted the first hook event for this session. Never emitted on the wire (DTO strips it). */
		ingestKeyId: text("ingest_key_id"),
		// Acknowledgement model (WAITING vs IDLE): when the agent last finished a
		// turn (Stop) and when the user last acknowledged a result (UserPromptSubmit
		// or the synthetic UserAcknowledge hook). Both nullable, server receive-time
		// ISO strings; rows predating the columns stay null.
		lastAgentTurnCompletedAt: text("last_agent_turn_completed_at"),
		lastUserAcknowledgedAt: text("last_user_acknowledged_at"),
		/**
		 * The machine name a relay or the Codex observer reported for this session (display only).
		 * Self-declared by the sender, so it is unauthenticated: never use it for ownership, access
		 * or routing. Null when nothing reported one (direct-mode hooks send none). A managed
		 * session's real host is managed_sessions.host_name, not this.
		 */
		reportedHost: text("reported_host"),
	},
	(t) => ({
		agentTypeLastActivity: index(AGENT_TYPE_LAST_ACTIVITY_INDEX).on(t.agentType, t.lastActivityAt),
		ownerLastActivity: index(OWNER_LAST_ACTIVITY_INDEX).on(t.ownerUserId, t.lastActivityAt),
	}),
);

export const sessionsPg = pgTable(
	"sessions",
	{
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
		ownerUserId: pgText("owner_user_id"),
		ingestKeyId: pgText("ingest_key_id"),
		lastAgentTurnCompletedAt: pgText("last_agent_turn_completed_at"),
		lastUserAcknowledgedAt: pgText("last_user_acknowledged_at"),
		reportedHost: pgText("reported_host"),
	},
	(t) => ({
		agentTypeLastActivity: pgIndex(AGENT_TYPE_LAST_ACTIVITY_INDEX).on(
			t.agentType,
			t.lastActivityAt,
		),
		ownerLastActivity: pgIndex(OWNER_LAST_ACTIVITY_INDEX).on(t.ownerUserId, t.lastActivityAt),
	}),
);
