/**
 * ai_hitl_deliveries — dual-dialect (Decision 21 / 22).
 *
 * One row per decided proposal (`proposal_id` is unique): where the approved
 * prompt went. It does not mirror the control action's progress. `control_action_id`
 * names the action currently carrying the prompt, and the delivery state a caller
 * sees is derived from that action's own status, so no writer has to remember to
 * update this row. `terminal_state` is set only when there is no action to follow:
 * `not_managed`, `blocked`, or `audit_only` (a Telegram decision, which never forwards).
 *
 * `attempt` counts sends of the prompt; a retry moves `control_action_id` to a new
 * action and bumps it in one guarded write, so of two concurrent retries one wins.
 *
 * `prompt_hash` is the SHA-256 of the prompt that was sent. The prompt itself is
 * never stored here and never leaves in a delivery response.
 *
 * `approved_by_user_id` / `approved_by_key_id` record who approved, for the audit
 * trail. They are plain columns: users and keys are deleted on their own schedule.
 *
 * Born with an inline cascade FK to sessions on both dialects, as mobile_device_activities
 * is: a deleted session takes its deliveries with it.
 */
import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "../core/sessions.js";

const PROPOSAL_UNIQUE = "ai_hitl_deliveries_proposal_unique";
const SESSION_INDEX = "idx_ai_hitl_deliveries_session";

export const aiHitlDeliveriesSqlite = sqliteTable(
	"ai_hitl_deliveries",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		proposalId: text("proposal_id").notNull(),
		hitlId: text("hitl_id").notNull(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		controlActionId: text("control_action_id"),
		attempt: integer("attempt").notNull().default(1),
		terminalState: text("terminal_state"),
		approvedByUserId: text("approved_by_user_id"),
		approvedByKeyId: text("approved_by_key_id"),
		promptHash: text("prompt_hash"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => ({
		proposalUnique: uniqueIndex(PROPOSAL_UNIQUE).on(t.proposalId),
		sessionIdx: index(SESSION_INDEX).on(t.sessionId),
	}),
);

export const aiHitlDeliveriesPg = pgTable(
	"ai_hitl_deliveries",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		proposalId: pgText("proposal_id").notNull(),
		hitlId: pgText("hitl_id").notNull(),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		controlActionId: pgText("control_action_id"),
		attempt: pgInteger("attempt").notNull().default(1),
		terminalState: pgText("terminal_state"),
		approvedByUserId: pgText("approved_by_user_id"),
		approvedByKeyId: pgText("approved_by_key_id"),
		promptHash: pgText("prompt_hash"),
		createdAt: pgText("created_at").notNull(),
		updatedAt: pgText("updated_at").notNull(),
	},
	(t) => ({
		proposalUnique: pgUniqueIndex(PROPOSAL_UNIQUE).on(t.proposalId),
		sessionIdx: pgIndex(SESSION_INDEX).on(t.sessionId),
	}),
);
