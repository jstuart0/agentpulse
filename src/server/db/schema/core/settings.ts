/**
 * Dual-dialect proof: settings table.
 *
 * Column factory pattern (Decision 21): columns are defined once in a factory
 * function and instantiated as both sqliteTable and pgTable. For Phase 1 this
 * is the only table using the pattern; Phase 2a extends it to all tables.
 *
 * JSON column strategy (Decision 14): value uses text({mode:'json'}) on SQLite
 * and json() on Postgres — NOT jsonb(). The runtime contract (parsed JS
 * object/array/scalar) is identical across both dialects.
 */
import { sql } from "drizzle-orm";
import { json, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";

function defineSettingsSqliteColumns() {
	return {
		key: sqliteText("key").primaryKey(),
		value: sqliteText("value", { mode: "json" }).$type<unknown>().notNull(),
		updatedAt: sqliteText("updated_at").notNull().default(sql`(datetime('now'))`),
	};
}

function defineSettingsPgColumns() {
	return {
		key: pgText("key").primaryKey(),
		value: json("value").$type<unknown>().notNull(),
		updatedAt: pgText("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	};
}

export const settingsSqlite = sqliteTable("settings", defineSettingsSqliteColumns());
export const settingsPg = pgTable("settings", defineSettingsPgColumns());
