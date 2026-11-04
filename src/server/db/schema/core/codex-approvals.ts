/**
 * codex_approvals and codex_approval_audit — dual-dialect (AGEN-87).
 *
 * codex_approvals: one row per approval request a managed Codex session made,
 * keyed by (session_id, runtime_epoch, rpc_id). Only services/codex-approvals.ts
 * writes it. It is born with its cascade FK on both dialects, so it is
 * deliberately not in the legacy `rebuildSessionChildFks` list (same as
 * managed_delivery_receipts). Every timestamp is ISO text written by the
 * service, never a database default, so expiry compares as text on both
 * dialects.
 *
 * `presentation` holds the canonical JSON text of what a person is shown (the
 * hash is over exactly these bytes); `presentation` and `reason_text` are
 * nulled when the row closes and the hash stays.
 *
 * codex_approval_audit: append-only record of who answered which version.
 * Deliberately NO foreign keys: it outlives the session, and it sits outside
 * retention. BEFORE UPDATE / DELETE / TRUNCATE triggers (db/codex-approvals-ddl.ts,
 * installed by hand-written SQL in migration 0020 and the legacy init) let only
 * `outcome` and `completed_at` change, and only from 'pending'. Drizzle does
 * not model triggers.
 */
import {
	boolean,
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

const UNIQUE_KEY = "uq_codex_approvals_session_epoch_rpc";
const SESSION_STATUS = "idx_codex_approvals_session_status";
const SESSION_CREATED = "idx_codex_approvals_session_created";
const STATUS_EXPIRES = "idx_codex_approvals_status_expires";
const AUDIT_APPROVAL = "idx_codex_approval_audit_approval";
const AUDIT_SESSION_CREATED = "idx_codex_approval_audit_session_created";

export const codexApprovalsSqlite = sqliteTable(
	"codex_approvals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		runtimeEpoch: text("runtime_epoch").notNull(),
		rpcId: text("rpc_id").notNull(),
		requestKind: text("request_kind").notNull(),
		threadId: text("thread_id").notNull(),
		turnId: text("turn_id").notNull(),
		itemId: text("item_id").notNull(),
		providerApprovalId: text("provider_approval_id"),
		presentation: text("presentation"),
		reasonText: text("reason_text"),
		presentationHash: text("presentation_hash").notNull(),
		presentationRevision: integer("presentation_revision").notNull(),
		approvable: integer("approvable", { mode: "boolean" }).notNull(),
		notApprovableReason: text("not_approvable_reason"),
		canCancel: integer("can_cancel", { mode: "boolean" }).notNull().default(false),
		status: text("status").notNull(),
		closedReason: text("closed_reason"),
		hostOutcome: text("host_outcome"),
		decision: text("decision"),
		answeredByUserId: text("answered_by_user_id"),
		answeredByKeyId: text("answered_by_key_id"),
		answeredAt: text("answered_at"),
		firstDeliveredAt: text("first_delivered_at"),
		lastIssuedAt: text("last_issued_at"),
		fencedAt: text("fenced_at"),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		closedAt: text("closed_at"),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => ({
		sessionEpochRpcUniq: uniqueIndex(UNIQUE_KEY).on(t.sessionId, t.runtimeEpoch, t.rpcId),
		sessionStatusIdx: index(SESSION_STATUS).on(t.sessionId, t.status),
		sessionCreatedIdx: index(SESSION_CREATED).on(t.sessionId, t.createdAt),
		statusExpiresIdx: index(STATUS_EXPIRES).on(t.status, t.expiresAt),
	}),
);

export const codexApprovalsPg = pgTable(
	"codex_approvals",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		runtimeEpoch: pgText("runtime_epoch").notNull(),
		rpcId: pgText("rpc_id").notNull(),
		requestKind: pgText("request_kind").notNull(),
		threadId: pgText("thread_id").notNull(),
		turnId: pgText("turn_id").notNull(),
		itemId: pgText("item_id").notNull(),
		providerApprovalId: pgText("provider_approval_id"),
		presentation: pgText("presentation"),
		reasonText: pgText("reason_text"),
		presentationHash: pgText("presentation_hash").notNull(),
		presentationRevision: pgInteger("presentation_revision").notNull(),
		approvable: boolean("approvable").notNull(),
		notApprovableReason: pgText("not_approvable_reason"),
		canCancel: boolean("can_cancel").notNull().default(false),
		status: pgText("status").notNull(),
		closedReason: pgText("closed_reason"),
		hostOutcome: pgText("host_outcome"),
		decision: pgText("decision"),
		answeredByUserId: pgText("answered_by_user_id"),
		answeredByKeyId: pgText("answered_by_key_id"),
		answeredAt: pgText("answered_at"),
		firstDeliveredAt: pgText("first_delivered_at"),
		lastIssuedAt: pgText("last_issued_at"),
		fencedAt: pgText("fenced_at"),
		createdAt: pgText("created_at").notNull(),
		expiresAt: pgText("expires_at").notNull(),
		closedAt: pgText("closed_at"),
		updatedAt: pgText("updated_at").notNull(),
	},
	(t) => ({
		sessionEpochRpcUniq: pgUniqueIndex(UNIQUE_KEY).on(t.sessionId, t.runtimeEpoch, t.rpcId),
		sessionStatusIdx: pgIndex(SESSION_STATUS).on(t.sessionId, t.status),
		sessionCreatedIdx: pgIndex(SESSION_CREATED).on(t.sessionId, t.createdAt),
		statusExpiresIdx: pgIndex(STATUS_EXPIRES).on(t.status, t.expiresAt),
	}),
);

export const codexApprovalAuditSqlite = sqliteTable(
	"codex_approval_audit",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		approvalId: text("approval_id").notNull(),
		sessionId: text("session_id").notNull(),
		hostName: text("host_name"),
		actorUserId: text("actor_user_id"),
		actorKeyId: text("actor_key_id"),
		actorLabel: text("actor_label").notNull(),
		requestKind: text("request_kind").notNull(),
		revision: integer("revision").notNull(),
		presentationHash: text("presentation_hash").notNull(),
		decision: text("decision").notNull(),
		outcome: text("outcome").notNull().default("pending"),
		createdAt: text("created_at").notNull(),
		completedAt: text("completed_at"),
	},
	(t) => ({
		approvalIdx: index(AUDIT_APPROVAL).on(t.approvalId),
		sessionCreatedIdx: index(AUDIT_SESSION_CREATED).on(t.sessionId, t.createdAt),
	}),
);

export const codexApprovalAuditPg = pgTable(
	"codex_approval_audit",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		approvalId: pgText("approval_id").notNull(),
		sessionId: pgText("session_id").notNull(),
		hostName: pgText("host_name"),
		actorUserId: pgText("actor_user_id"),
		actorKeyId: pgText("actor_key_id"),
		actorLabel: pgText("actor_label").notNull(),
		requestKind: pgText("request_kind").notNull(),
		revision: pgInteger("revision").notNull(),
		presentationHash: pgText("presentation_hash").notNull(),
		decision: pgText("decision").notNull(),
		outcome: pgText("outcome").notNull().default("pending"),
		createdAt: pgText("created_at").notNull(),
		completedAt: pgText("completed_at"),
	},
	(t) => ({
		approvalIdx: pgIndex(AUDIT_APPROVAL).on(t.approvalId),
		sessionCreatedIdx: pgIndex(AUDIT_SESSION_CREATED).on(t.sessionId, t.createdAt),
	}),
);
