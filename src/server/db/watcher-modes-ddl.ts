/**
 * Hand-written DDL that Drizzle can't model, shared by the SQLite Drizzle
 * migration (0012), the legacy SQLite init in client.ts and the tests. The
 * migration files hold these strings verbatim; watcher-modes-migration.test.ts
 * fails when they drift.
 */

/**
 * Keeps the open watcher run with the highest rowid per session and cancels
 * the rest, so the unique "one open run per session" index can be created.
 * rowid is used because created_at formats are mixed on SQLite. One statement.
 */
export const DEDUPE_OPEN_RUNS_SQL = `UPDATE ai_watcher_runs SET status = 'cancelled', last_error_sub_type = 'duplicate_open_run', completed_at = datetime('now'), updated_at = datetime('now') WHERE status IN ('queued', 'claimed', 'running') AND rowid <> (SELECT MAX(newer.rowid) FROM ai_watcher_runs newer WHERE newer.session_id = ai_watcher_runs.session_id AND newer.status IN ('queued', 'claimed', 'running'))`;

/** Every ai_dispatch_audit column except the three a transition may change. */
const AUDIT_IMMUTABLE_COLUMNS = [
	"id",
	"created_at",
	"session_id",
	"session_name",
	"actor_kind",
	"actor_user_id",
	"actor_label",
	"telegram_from_id",
	"telegram_chat_id",
	"prompt_sha256",
	"prompt_text",
	"continue_kind",
	"proposal_id",
	"hitl_id",
	"turn_key",
	"provider_id",
	"model",
	"control_action_id",
	"config_snapshot",
] as const;

const AUDIT_ILLEGAL_TRANSITION = `NOT ((OLD.outcome = 'pending' AND NEW.outcome IN ('sent', 'refused', 'failed')) OR (OLD.outcome = 'sent' AND NEW.outcome = 'failed' AND COALESCE(NEW.refusal_code, '') = 'expired_unclaimed'))`;

/**
 * Append-only enforcement for ai_dispatch_audit on SQLite: an update may only
 * move pending -> sent | refused | failed, or sent -> failed with
 * refusal_code 'expired_unclaimed', and may change only outcome, refusal_code
 * and completed_at. Nothing is ever deleted.
 */
export const AI_DISPATCH_AUDIT_TRIGGERS_SQLITE: readonly string[] = [
	`CREATE TRIGGER IF NOT EXISTS trg_ai_dispatch_audit_update BEFORE UPDATE ON ai_dispatch_audit WHEN ${AUDIT_IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} OR ${AUDIT_ILLEGAL_TRANSITION} BEGIN SELECT RAISE(ABORT, 'ai_dispatch_audit_append_only'); END`,
	"CREATE TRIGGER IF NOT EXISTS trg_ai_dispatch_audit_delete BEFORE DELETE ON ai_dispatch_audit BEGIN SELECT RAISE(ABORT, 'ai_dispatch_audit_append_only'); END",
];

/**
 * The same rule for Postgres. json has no equality operator, so the one json
 * column is compared as text. Used by tests that need to rebuild the guard.
 */
export const AI_DISPATCH_AUDIT_GUARD_FUNCTION_POSTGRES = `CREATE OR REPLACE FUNCTION ai_dispatch_audit_guard() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION 'ai_dispatch_audit_append_only';
	END IF;
	IF ${AUDIT_IMMUTABLE_COLUMNS.map((c) => (c === "config_snapshot" ? "NEW.config_snapshot::text IS DISTINCT FROM OLD.config_snapshot::text" : `NEW.${c} IS DISTINCT FROM OLD.${c}`)).join("\n\t\tOR ")}
		OR ${AUDIT_ILLEGAL_TRANSITION} THEN
		RAISE EXCEPTION 'ai_dispatch_audit_append_only';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql`;
