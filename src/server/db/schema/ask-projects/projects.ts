/**
 * projects table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const projectsSqlite = sqliteTable("projects", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull().unique(),
	cwd: text("cwd").notNull(),
	githubRepoUrl: text("github_repo_url"),
	defaultAgentType: text("default_agent_type"),
	defaultModel: text("default_model"),
	defaultLaunchMode: text("default_launch_mode"),
	notes: text("notes"),
	tags: jsonColumn<string[]>("sqlite", "tags"),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	metadata: jsonColumn<Record<string, unknown>>("sqlite", "metadata"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const projectsPg = pgTable("projects", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: pgText("name").notNull().unique(),
	cwd: pgText("cwd").notNull(),
	githubRepoUrl: pgText("github_repo_url"),
	defaultAgentType: pgText("default_agent_type"),
	defaultModel: pgText("default_model"),
	defaultLaunchMode: pgText("default_launch_mode"),
	notes: pgText("notes"),
	tags: jsonColumn<string[]>("postgres", "tags"),
	isFavorite: boolean("is_favorite").notNull().default(false),
	metadata: jsonColumn<Record<string, unknown>>("postgres", "metadata"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
