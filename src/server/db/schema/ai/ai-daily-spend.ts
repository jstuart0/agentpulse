/**
 * ai_daily_spend table — dual-dialect (Decision 21 / Decision 22).
 *
 * Composite PK on (user_id, date) — same shape on both dialects via
 * primaryKey({columns: [t.userId, t.date]}) (Decision in Phase 2a brief).
 */
import { sql } from "drizzle-orm";
import {
	integer as pgInteger,
	primaryKey as pgPrimaryKey,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const aiDailySpendSqlite = sqliteTable(
	"ai_daily_spend",
	{
		userId: text("user_id").notNull(),
		date: text("date").notNull(),
		spendCents: integer("spend_cents").notNull().default(0),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.userId, t.date] }),
	}),
);

export const aiDailySpendPg = pgTable(
	"ai_daily_spend",
	{
		userId: pgText("user_id").notNull(),
		date: pgText("date").notNull(),
		spendCents: pgInteger("spend_cents").notNull().default(0),
		updatedAt: tsColumn("postgres", "updated_at"),
	},
	(t) => ({
		pk: pgPrimaryKey({ columns: [t.userId, t.date] }),
	}),
);
