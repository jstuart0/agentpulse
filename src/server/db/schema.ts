import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sessions = sqliteTable("sessions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull().unique(),
	displayName: text("display_name"), // Human-friendly name like "brave-falcon"
	agentType: text("agent_type").notNull(), // claude_code | codex_cli
	status: text("status").notNull().default("active"), // active | idle | completed | failed
	cwd: text("cwd"),
	transcriptPath: text("transcript_path"),
	model: text("model"),
	startedAt: text("started_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	lastActivityAt: text("last_activity_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	endedAt: text("ended_at"),
	semanticStatus: text("semantic_status"), // researching | implementing | testing | etc.
	currentTask: text("current_task"),
	planSummary: text("plan_summary", { mode: "json" }).$type<string[]>(),
	totalToolUses: integer("total_tool_uses").notNull().default(0),
	isWorking: integer("is_working", { mode: "boolean" }).notNull().default(false),
	isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
	gitBranch: text("git_branch"),
	claudeMdContent: text("claude_md_content"),
	claudeMdPath: text("claude_md_path"),
	claudeMdChecksum: text("claude_md_checksum"),
	claudeMdUpdatedAt: text("claude_md_updated_at"),
	notes: text("notes").default(""),
	metadata: text("metadata", { mode: "json" })
		.$type<Record<string, unknown>>()
		.default({}),
});

export const events = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.sessionId),
	eventType: text("event_type").notNull(),
	category: text("category"),
	content: text("content"),
	isNoise: integer("is_noise", { mode: "boolean" }).notNull().default(false),
	providerEventType: text("provider_event_type"),
	toolName: text("tool_name"),
	toolInput: text("tool_input", { mode: "json" }).$type<Record<string, unknown>>(),
	toolResponse: text("tool_response"),
	rawPayload: text("raw_payload", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull(),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const apiKeys = sqliteTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	keyHash: text("key_hash").notNull().unique(),
	keyPrefix: text("key_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	lastUsedAt: text("last_used_at"),
});

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const sessionTemplates = sqliteTable("session_templates", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	description: text("description"),
	agentType: text("agent_type").notNull(),
	cwd: text("cwd").notNull(),
	baseInstructions: text("base_instructions").notNull().default(""),
	taskPrompt: text("task_prompt").notNull().default(""),
	model: text("model"),
	approvalPolicy: text("approval_policy"),
	sandboxMode: text("sandbox_mode"),
	env: text("env", { mode: "json" })
		.$type<Record<string, string>>()
		.notNull()
		.default({}),
	tags: text("tags", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});
