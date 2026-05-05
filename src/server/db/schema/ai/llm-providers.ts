/**
 * llm_providers table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const llmProvidersSqlite = sqliteTable("llm_providers", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: text("user_id").notNull().default("local"),
	name: text("name").notNull(),
	kind: text("kind").notNull(),
	model: text("model").notNull(),
	baseUrl: text("base_url"),
	credentialCiphertext: text("credential_ciphertext").notNull(),
	credentialHint: text("credential_hint").notNull(),
	isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const llmProvidersPg = pgTable("llm_providers", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: pgText("user_id").notNull().default("local"),
	name: pgText("name").notNull(),
	kind: pgText("kind").notNull(),
	model: pgText("model").notNull(),
	baseUrl: pgText("base_url"),
	credentialCiphertext: pgText("credential_ciphertext").notNull(),
	credentialHint: pgText("credential_hint").notNull(),
	isDefault: boolean("is_default").notNull().default(false),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
