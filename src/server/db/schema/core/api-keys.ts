/**
 * api_keys table — dual-dialect (Decision 21 / Decision 22).
 *
 * owner_user_id is null for a service key; the owner's role (resolved at
 * use time) authorizes the key. Indexed by idx_api_keys_owner for an
 * owner-filtered key list.
 */
import { sql } from "drizzle-orm";
import { boolean, index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

const OWNER_INDEX = "idx_api_keys_owner";

export const apiKeysSqlite = sqliteTable(
	"api_keys",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name").notNull(),
		keyHash: text("key_hash").notNull().unique(),
		keyPrefix: text("key_prefix").notNull(),
		isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		lastUsedAt: text("last_used_at"),
		scopes: text("scopes").notNull().default('["ingest"]'),
		/** null = service key (no owner). */
		ownerUserId: text("owner_user_id"),
		createdByUserId: text("created_by_user_id"),
	},
	(t) => ({
		ownerIdx: index(OWNER_INDEX).on(t.ownerUserId),
	}),
);

export const apiKeysPg = pgTable(
	"api_keys",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: pgText("name").notNull(),
		keyHash: pgText("key_hash").notNull().unique(),
		keyPrefix: pgText("key_prefix").notNull(),
		isActive: boolean("is_active").notNull().default(true),
		createdAt: tsColumn("postgres", "created_at"),
		lastUsedAt: pgText("last_used_at"),
		scopes: pgText("scopes").notNull().default('["ingest"]'),
		ownerUserId: pgText("owner_user_id"),
		createdByUserId: pgText("created_by_user_id"),
	},
	(t) => ({
		ownerIdx: pgIndex(OWNER_INDEX).on(t.ownerUserId),
	}),
);
