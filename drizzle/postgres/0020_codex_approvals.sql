CREATE TABLE "codex_approval_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"session_id" text NOT NULL,
	"host_name" text,
	"actor_user_id" text,
	"actor_key_id" text,
	"actor_label" text NOT NULL,
	"request_kind" text NOT NULL,
	"revision" integer NOT NULL,
	"presentation_hash" text NOT NULL,
	"decision" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "codex_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"runtime_epoch" text NOT NULL,
	"rpc_id" text NOT NULL,
	"request_kind" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"item_id" text NOT NULL,
	"provider_approval_id" text,
	"presentation" text,
	"reason_text" text,
	"presentation_hash" text NOT NULL,
	"presentation_revision" integer NOT NULL,
	"approvable" boolean NOT NULL,
	"not_approvable_reason" text,
	"can_cancel" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"closed_reason" text,
	"host_outcome" text,
	"decision" text,
	"answered_by_user_id" text,
	"answered_by_key_id" text,
	"answered_at" text,
	"first_delivered_at" text,
	"last_issued_at" text,
	"fenced_at" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"closed_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "codex_approvals" ADD CONSTRAINT "codex_approvals_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_codex_approval_audit_approval" ON "codex_approval_audit" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "idx_codex_approval_audit_session_created" ON "codex_approval_audit" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_codex_approvals_session_epoch_rpc" ON "codex_approvals" USING btree ("session_id","runtime_epoch","rpc_id");--> statement-breakpoint
CREATE INDEX "idx_codex_approvals_session_status" ON "codex_approvals" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "idx_codex_approvals_session_created" ON "codex_approvals" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_codex_approvals_status_expires" ON "codex_approvals" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION codex_approval_audit_guard() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION 'codex_approval_audit_append_only';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
		OR NEW.session_id IS DISTINCT FROM OLD.session_id
		OR NEW.host_name IS DISTINCT FROM OLD.host_name
		OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
		OR NEW.actor_key_id IS DISTINCT FROM OLD.actor_key_id
		OR NEW.actor_label IS DISTINCT FROM OLD.actor_label
		OR NEW.request_kind IS DISTINCT FROM OLD.request_kind
		OR NEW.revision IS DISTINCT FROM OLD.revision
		OR NEW.presentation_hash IS DISTINCT FROM OLD.presentation_hash
		OR NEW.decision IS DISTINCT FROM OLD.decision
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NOT (OLD.outcome = 'pending' AND NEW.outcome <> 'pending' AND NEW.completed_at IS NOT NULL) THEN
		RAISE EXCEPTION 'codex_approval_audit_append_only';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION codex_approvals_finalize_audit() RETURNS trigger AS $$
BEGIN
	UPDATE codex_approval_audit
	SET outcome = CASE WHEN OLD.first_delivered_at IS NOT NULL THEN 'session_deleted_after_issue' ELSE 'session_deleted' END,
		completed_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
	WHERE approval_id = OLD.id AND outcome = 'pending';
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_codex_approval_audit_update ON codex_approval_audit;
--> statement-breakpoint
CREATE TRIGGER trg_codex_approval_audit_update BEFORE UPDATE ON codex_approval_audit FOR EACH ROW EXECUTE FUNCTION codex_approval_audit_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_codex_approval_audit_delete ON codex_approval_audit;
--> statement-breakpoint
CREATE TRIGGER trg_codex_approval_audit_delete BEFORE DELETE ON codex_approval_audit FOR EACH ROW EXECUTE FUNCTION codex_approval_audit_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_codex_approval_audit_truncate ON codex_approval_audit;
--> statement-breakpoint
CREATE TRIGGER trg_codex_approval_audit_truncate BEFORE TRUNCATE ON codex_approval_audit FOR EACH STATEMENT EXECUTE FUNCTION codex_approval_audit_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_codex_approvals_finalize_audit ON codex_approvals;
--> statement-breakpoint
CREATE TRIGGER trg_codex_approvals_finalize_audit BEFORE DELETE ON codex_approvals FOR EACH ROW EXECUTE FUNCTION codex_approvals_finalize_audit();
