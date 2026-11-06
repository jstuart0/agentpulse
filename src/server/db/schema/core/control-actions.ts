/**
 * control_actions table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK. Note: session_id is nullable here (same as original).
 */
import { sql } from "drizzle-orm";
import { index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import { sessionsPg } from "./sessions.js";

/**
 * The same name the legacy SQLite init creates (`db/client.ts`), so both paths converge on one index. Every
 * read of a session's control history, and the detail's lookup of its newest fork, seeks by it.
 */
const SESSION_INDEX = "idx_control_actions_session";

export const controlActionsSqlite = sqliteTable(
	"control_actions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id"),
		launchRequestId: text("launch_request_id"),
		actionType: text("action_type").notNull(),
		requestedBy: text("requested_by"),
		status: text("status").notNull().default("queued"),
		error: text("error"),
		metadata: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
		idempotencyKey: text("idempotency_key"),
		claimedBySupervisorId: text("claimed_by_supervisor_id"),
		finishedAt: text("finished_at"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
		/** The user who requested this control action. requestedBy stays the actor-kind label (e.g. "user", "api_key", "ai"). */
		requestedByUserId: text("requested_by_user_id"),
	},
	(t) => ({ sessionIdx: index(SESSION_INDEX).on(t.sessionId) }),
);

export const controlActionsPg = pgTable(
	"control_actions",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		// Postgres: cascade FK (nullable — session_id can be null). Decision 7.
		sessionId: pgText("session_id").references(() => sessionsPg.sessionId, {
			onDelete: "cascade",
		}),
		launchRequestId: pgText("launch_request_id"),
		actionType: pgText("action_type").notNull(),
		requestedBy: pgText("requested_by"),
		status: pgText("status").notNull().default("queued"),
		error: pgText("error"),
		metadata: jsonColumn<Record<string, unknown>>("postgres", "metadata_json"),
		idempotencyKey: pgText("idempotency_key"),
		claimedBySupervisorId: pgText("claimed_by_supervisor_id"),
		finishedAt: pgText("finished_at"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
		requestedByUserId: pgText("requested_by_user_id"),
	},
	(t) => ({ sessionIdx: pgIndex(SESSION_INDEX).on(t.sessionId) }),
);
