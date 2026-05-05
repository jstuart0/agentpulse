/**
 * project_alert_rules table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { boolean, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const projectAlertRulesSqlite = sqliteTable("project_alert_rules", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull(),
	ruleType: text("rule_type").notNull(),
	params: text("params", { mode: "json" }).$type<Record<string, unknown>>(),
	channelId: text("channel_id"),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	dailyTokenSpendCents: integer("daily_token_spend_cents").notNull().default(0),
	dailyTokenSpendDate: text("daily_token_spend_date"),
	lastEvaluatedEventId: integer("last_evaluated_event_id").notNull().default(0),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const projectAlertRulesPg = pgTable("project_alert_rules", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	projectId: pgText("project_id").notNull(),
	ruleType: pgText("rule_type").notNull(),
	params: jsonColumn<Record<string, unknown>>("postgres", "params"),
	channelId: pgText("channel_id"),
	isActive: boolean("is_active").notNull().default(true),
	dailyTokenSpendCents: pgInteger("daily_token_spend_cents").notNull().default(0),
	dailyTokenSpendDate: pgText("daily_token_spend_date"),
	lastEvaluatedEventId: pgInteger("last_evaluated_event_id").notNull().default(0),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
