/**
 * Hand-written DDL that Drizzle can't model, shared by migration 0020 on both
 * dialects, the legacy SQLite init in client.ts and the tests. The migration
 * files hold these strings verbatim; codex-approvals-migration.test.ts fails
 * when they drift.
 *
 * codex_approval_audit is append-only: no row is deleted or truncated, and an
 * update may change only `outcome` and `completed_at`, only once, from
 * 'pending' to a final outcome. A BEFORE DELETE trigger on codex_approvals
 * finalizes the audit row of a deleted approval (a session delete cascades), so
 * none is left 'pending' for a session that no longer exists.
 */

const AUDIT_IMMUTABLE_COLUMNS = [
	"id",
	"approval_id",
	"session_id",
	"host_name",
	"actor_user_id",
	"actor_key_id",
	"actor_label",
	"request_kind",
	"revision",
	"presentation_hash",
	"decision",
	"created_at",
] as const;

/** Outcome an audit row takes when its approval row is deleted while the audit is still pending. */
export const SESSION_DELETED_OUTCOME = "session_deleted";
/** The same, when an accept had already been issued to the host: it may have run. */
export const SESSION_DELETED_AFTER_ISSUE_OUTCOME = "session_deleted_after_issue";

const AUDIT_ILLEGAL_TRANSITION =
	"NOT (OLD.outcome = 'pending' AND NEW.outcome <> 'pending' AND NEW.completed_at IS NOT NULL)";

export const CODEX_APPROVAL_AUDIT_VIOLATION = "codex_approval_audit_append_only";

/** SQLite: append-only enforcement plus the finalize-on-delete trigger. */
export const CODEX_APPROVAL_TRIGGERS_SQLITE: readonly string[] = [
	`CREATE TRIGGER IF NOT EXISTS trg_codex_approval_audit_update BEFORE UPDATE ON codex_approval_audit WHEN ${AUDIT_IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} OR ${AUDIT_ILLEGAL_TRANSITION} BEGIN SELECT RAISE(ABORT, '${CODEX_APPROVAL_AUDIT_VIOLATION}'); END`,
	`CREATE TRIGGER IF NOT EXISTS trg_codex_approval_audit_delete BEFORE DELETE ON codex_approval_audit BEGIN SELECT RAISE(ABORT, '${CODEX_APPROVAL_AUDIT_VIOLATION}'); END`,
	`CREATE TRIGGER IF NOT EXISTS trg_codex_approvals_finalize_audit BEFORE DELETE ON codex_approvals BEGIN UPDATE codex_approval_audit SET outcome = CASE WHEN OLD.first_delivered_at IS NOT NULL THEN '${SESSION_DELETED_AFTER_ISSUE_OUTCOME}' ELSE '${SESSION_DELETED_OUTCOME}' END, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE approval_id = OLD.id AND outcome = 'pending'; END`,
];

/** Postgres: the guard function. Used by the migration and by tests that rebuild the guard. */
export const CODEX_APPROVAL_AUDIT_GUARD_FUNCTION_POSTGRES = `CREATE OR REPLACE FUNCTION codex_approval_audit_guard() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION '${CODEX_APPROVAL_AUDIT_VIOLATION}';
	END IF;
	IF ${AUDIT_IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join("\n\t\tOR ")}
		OR ${AUDIT_ILLEGAL_TRANSITION} THEN
		RAISE EXCEPTION '${CODEX_APPROVAL_AUDIT_VIOLATION}';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql`;

/** Postgres: finalizes the audit row of an approval that is being deleted. */
export const CODEX_APPROVALS_FINALIZE_AUDIT_FUNCTION_POSTGRES = `CREATE OR REPLACE FUNCTION codex_approvals_finalize_audit() RETURNS trigger AS $$
BEGIN
	UPDATE codex_approval_audit
	SET outcome = CASE WHEN OLD.first_delivered_at IS NOT NULL THEN '${SESSION_DELETED_AFTER_ISSUE_OUTCOME}' ELSE '${SESSION_DELETED_OUTCOME}' END,
		completed_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
	WHERE approval_id = OLD.id AND outcome = 'pending';
	RETURN OLD;
END;
$$ LANGUAGE plpgsql`;

/** Postgres: every statement after the tables exist, in order. */
export const CODEX_APPROVAL_STATEMENTS_POSTGRES: readonly string[] = [
	CODEX_APPROVAL_AUDIT_GUARD_FUNCTION_POSTGRES,
	CODEX_APPROVALS_FINALIZE_AUDIT_FUNCTION_POSTGRES,
	"DROP TRIGGER IF EXISTS trg_codex_approval_audit_update ON codex_approval_audit",
	"CREATE TRIGGER trg_codex_approval_audit_update BEFORE UPDATE ON codex_approval_audit FOR EACH ROW EXECUTE FUNCTION codex_approval_audit_guard()",
	"DROP TRIGGER IF EXISTS trg_codex_approval_audit_delete ON codex_approval_audit",
	"CREATE TRIGGER trg_codex_approval_audit_delete BEFORE DELETE ON codex_approval_audit FOR EACH ROW EXECUTE FUNCTION codex_approval_audit_guard()",
	"DROP TRIGGER IF EXISTS trg_codex_approval_audit_truncate ON codex_approval_audit",
	"CREATE TRIGGER trg_codex_approval_audit_truncate BEFORE TRUNCATE ON codex_approval_audit FOR EACH STATEMENT EXECUTE FUNCTION codex_approval_audit_guard()",
	"DROP TRIGGER IF EXISTS trg_codex_approvals_finalize_audit ON codex_approvals",
	"CREATE TRIGGER trg_codex_approvals_finalize_audit BEFORE DELETE ON codex_approvals FOR EACH ROW EXECUTE FUNCTION codex_approvals_finalize_audit()",
];
