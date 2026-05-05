/**
 * session_templates table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const sessionTemplatesSqlite = sqliteTable("session_templates", {
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
	env: jsonColumn<Record<string, string>>("sqlite", "env").notNull().default({}),
	tags: jsonColumn<string[]>("sqlite", "tags").notNull().default([]),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	metadata: jsonColumn<Record<string, unknown>>("sqlite", "metadata"),
	projectId: text("project_id"),
	templateProjectOverrides: jsonColumn<string[]>("sqlite", "template_project_overrides"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const sessionTemplatesPg = pgTable("session_templates", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: pgText("name").notNull(),
	description: pgText("description"),
	agentType: pgText("agent_type").notNull(),
	cwd: pgText("cwd").notNull(),
	baseInstructions: pgText("base_instructions").notNull().default(""),
	taskPrompt: pgText("task_prompt").notNull().default(""),
	model: pgText("model"),
	approvalPolicy: pgText("approval_policy"),
	sandboxMode: pgText("sandbox_mode"),
	env: jsonColumn<Record<string, string>>("postgres", "env").notNull().default({}),
	tags: jsonColumn<string[]>("postgres", "tags").notNull().default([]),
	isFavorite: boolean("is_favorite").notNull().default(false),
	metadata: jsonColumn<Record<string, unknown>>("postgres", "metadata"),
	projectId: pgText("project_id"),
	templateProjectOverrides: jsonColumn<string[]>("postgres", "template_project_overrides"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
