/**
 * fork_tool_calls — dual-dialect (AGEN-123).
 *
 * What each tool call of a continued Claude session ran: the input and the output, kept for the signed-in
 * owner (or an admin) to open. Only services/fork-tool-detail.ts reads or writes it
 * (fork-tool-calls-readers.guard.test.ts holds that). `input_cipher` and `output_cipher` are AES-256-GCM
 * ciphertext under AGENTPULSE_SECRETS_KEY (the mobile_devices.send_token scheme), so a database copy or a
 * backup alone yields no tool text. The columns hold the text after the server's redaction and cut, never
 * what the host sent.
 *
 * Born with its cascade FK on both dialects, so it is deliberately not in the legacy
 * `rebuildSessionChildFks` list (same as managed_delivery_receipts). `created_at` is ISO text written by the
 * service (`toDbTimestamp`), never a database default, so retention's text compare is the same on both.
 */
import {
	boolean,
	index as pgIndex,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

const UNIQUE_KEY = "uq_fork_tool_calls_session_tool_use";
const CREATED_AT = "idx_fork_tool_calls_created_at";
const SESSION_CREATED = "idx_fork_tool_calls_session_created";

export const forkToolCallsSqlite = sqliteTable(
	"fork_tool_calls",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		turnActionId: text("turn_action_id"),
		toolUseId: text("tool_use_id").notNull(),
		tool: text("tool").notNull(),
		outcome: text("outcome").notNull(),
		fromSubagent: integer("from_subagent", { mode: "boolean" }).notNull().default(false),
		inputCipher: text("input_cipher"),
		inputTruncated: integer("input_truncated", { mode: "boolean" }).notNull().default(false),
		outputCipher: text("output_cipher"),
		outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
		redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(t) => ({
		sessionToolUseUniq: uniqueIndex(UNIQUE_KEY).on(t.sessionId, t.toolUseId),
		createdAtIdx: index(CREATED_AT).on(t.createdAt),
		sessionCreatedIdx: index(SESSION_CREATED).on(t.sessionId, t.createdAt),
	}),
);

export const forkToolCallsPg = pgTable(
	"fork_tool_calls",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		turnActionId: pgText("turn_action_id"),
		toolUseId: pgText("tool_use_id").notNull(),
		tool: pgText("tool").notNull(),
		outcome: pgText("outcome").notNull(),
		fromSubagent: boolean("from_subagent").notNull().default(false),
		inputCipher: pgText("input_cipher"),
		inputTruncated: boolean("input_truncated").notNull().default(false),
		outputCipher: pgText("output_cipher"),
		outputTruncated: boolean("output_truncated").notNull().default(false),
		redacted: boolean("redacted").notNull().default(false),
		createdAt: pgText("created_at").notNull(),
	},
	(t) => ({
		sessionToolUseUniq: pgUniqueIndex(UNIQUE_KEY).on(t.sessionId, t.toolUseId),
		createdAtIdx: pgIndex(CREATED_AT).on(t.createdAt),
		sessionCreatedIdx: pgIndex(SESSION_CREATED).on(t.sessionId, t.createdAt),
	}),
);
