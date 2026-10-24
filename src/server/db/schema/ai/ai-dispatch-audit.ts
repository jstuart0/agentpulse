/**
 * ai_dispatch_audit table — dual-dialect (Decision 21 / Decision 22).
 * One row per attempt to send a prompt to an agent on a watcher's behalf.
 *
 * Deliberately NO foreign keys: the trail must survive the deletion of the
 * session it describes, and it sits outside event retention. It is append-only,
 * enforced by BEFORE UPDATE / BEFORE DELETE triggers installed by hand-written
 * SQL in the migrations and the legacy init (drizzle does not model triggers):
 * only `outcome`, `refusal_code` and `completed_at` may change, and only along
 * pending -> sent | refused | failed, or sent -> failed('expired_unclaimed').
 */
import { sql } from "drizzle-orm";
import { index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export interface DispatchConfigSnapshot {
	policy: string;
	autoConfirmedAt: string | null;
	autoConfirmedBy: string | null;
	continueEnabled: boolean;
	maxContinuations: number;
	continuationsUsed: number;
	/** SHA-256 of the system prompt, never the text. */
	systemPromptSha256: string | null;
}

export const aiDispatchAuditSqlite = sqliteTable(
	"ai_dispatch_audit",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		completedAt: text("completed_at"),
		outcome: text("outcome").notNull().default("pending"),
		refusalCode: text("refusal_code"),
		sessionId: text("session_id").notNull(),
		sessionName: text("session_name"),
		actorKind: text("actor_kind").notNull(),
		actorUserId: text("actor_user_id"),
		actorLabel: text("actor_label"),
		telegramFromId: text("telegram_from_id"),
		telegramChatId: text("telegram_chat_id"),
		promptSha256: text("prompt_sha256"),
		promptText: text("prompt_text"),
		continueKind: text("continue_kind"),
		proposalId: text("proposal_id"),
		hitlId: text("hitl_id"),
		turnKey: text("turn_key"),
		providerId: text("provider_id"),
		model: text("model"),
		controlActionId: text("control_action_id"),
		configSnapshot: text("config_snapshot", { mode: "json" }).$type<DispatchConfigSnapshot>(),
	},
	(t) => ({
		sessionCreated: index("idx_ai_dispatch_audit_session_created").on(t.sessionId, t.createdAt),
		outcomeCreated: index("idx_ai_dispatch_audit_outcome_created").on(t.outcome, t.createdAt),
	}),
);

export const aiDispatchAuditPg = pgTable(
	"ai_dispatch_audit",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		createdAt: tsColumn("postgres", "created_at"),
		completedAt: pgText("completed_at"),
		outcome: pgText("outcome").notNull().default("pending"),
		refusalCode: pgText("refusal_code"),
		sessionId: pgText("session_id").notNull(),
		sessionName: pgText("session_name"),
		actorKind: pgText("actor_kind").notNull(),
		actorUserId: pgText("actor_user_id"),
		actorLabel: pgText("actor_label"),
		telegramFromId: pgText("telegram_from_id"),
		telegramChatId: pgText("telegram_chat_id"),
		promptSha256: pgText("prompt_sha256"),
		promptText: pgText("prompt_text"),
		continueKind: pgText("continue_kind"),
		proposalId: pgText("proposal_id"),
		hitlId: pgText("hitl_id"),
		turnKey: pgText("turn_key"),
		providerId: pgText("provider_id"),
		model: pgText("model"),
		controlActionId: pgText("control_action_id"),
		configSnapshot: jsonColumn<DispatchConfigSnapshot>("postgres", "config_snapshot"),
	},
	(t) => ({
		sessionCreated: pgIndex("idx_ai_dispatch_audit_session_created").on(t.sessionId, t.createdAt),
		outcomeCreated: pgIndex("idx_ai_dispatch_audit_outcome_created").on(t.outcome, t.createdAt),
	}),
);
