/**
 * project_alert_rule_fires table — dual-dialect (Decision 21 / Decision 22).
 * De-bounce table: one record per (rule_id, session_id).
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";

export const projectAlertRuleFiresSqlite = sqliteTable(
	"project_alert_rule_fires",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		ruleId: text("rule_id").notNull(),
		sessionId: text("session_id").notNull(),
		firedAt: text("fired_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		uniq: uniqueIndex("idx_alert_rule_fires_rule_session").on(t.ruleId, t.sessionId),
	}),
);

export const projectAlertRuleFiresPg = pgTable(
	"project_alert_rule_fires",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		ruleId: pgText("rule_id").notNull(),
		sessionId: pgText("session_id").notNull(),
		firedAt: tsColumn("postgres", "fired_at"),
	},
	(t) => ({
		uniq: pgUniqueIndex("idx_alert_rule_fires_rule_session").on(t.ruleId, t.sessionId),
	}),
);
