CREATE TABLE IF NOT EXISTS "ai_dispatch_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed_at" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"refusal_code" text,
	"session_id" text NOT NULL,
	"session_name" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_label" text,
	"telegram_from_id" text,
	"telegram_chat_id" text,
	"prompt_sha256" text,
	"prompt_text" text,
	"continue_kind" text,
	"proposal_id" text,
	"hitl_id" text,
	"turn_key" text,
	"provider_id" text,
	"model" text,
	"control_action_id" text,
	"config_snapshot" json
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_watcher_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL CONSTRAINT "ai_watcher_reports_session_id_sessions_session_id_fk" REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action,
	"turn_key" text NOT NULL,
	"trigger_event_id" integer,
	"through_event_id" integer,
	"verdict" text,
	"why" text,
	"evidence_ids" json,
	"status" text DEFAULT 'claimed' NOT NULL,
	"failure_code" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"claimed_at" text,
	"provider_id" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"telegram_status" text,
	"telegram_sent_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD COLUMN IF NOT EXISTS "turn_key" text;--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD COLUMN IF NOT EXISTS "trigger_event_id" integer;--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD COLUMN IF NOT EXISTS "prompt_sha256" text;--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD COLUMN IF NOT EXISTS "approvable" boolean;--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD COLUMN IF NOT EXISTS "telegram_sent_at" text;--> statement-breakpoint
ALTER TABLE "watcher_configs" ADD COLUMN IF NOT EXISTS "notify_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_configs" ADD COLUMN IF NOT EXISTS "continue_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_configs" ADD COLUMN IF NOT EXISTS "auto_confirmed_at" text;--> statement-breakpoint
ALTER TABLE "watcher_configs" ADD COLUMN IF NOT EXISTS "auto_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "watcher_proposals" ADD COLUMN IF NOT EXISTS "turn_key" text;--> statement-breakpoint
ALTER TABLE "watcher_proposals" ADD COLUMN IF NOT EXISTS "suggested_prompt" text;--> statement-breakpoint
ALTER TABLE "watcher_proposals" ADD COLUMN IF NOT EXISTS "continue_kind" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_dispatch_audit_session_created" ON "ai_dispatch_audit" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_dispatch_audit_outcome_created" ON "ai_dispatch_audit" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_watcher_reports_session_turn" ON "ai_watcher_reports" USING btree ("session_id","turn_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_watcher_reports_session_created" ON "ai_watcher_reports" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_watcher_reports_telegram_sent" ON "ai_watcher_reports" USING btree ("telegram_sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_watcher_proposals_session_turn" ON "watcher_proposals" USING btree ("session_id","turn_key") WHERE "watcher_proposals"."turn_key" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai_dispatch_audit_guard() RETURNS trigger AS $$
BEGIN
	IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
		RAISE EXCEPTION 'ai_dispatch_audit_append_only';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.session_id IS DISTINCT FROM OLD.session_id
		OR NEW.session_name IS DISTINCT FROM OLD.session_name
		OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
		OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
		OR NEW.actor_label IS DISTINCT FROM OLD.actor_label
		OR NEW.telegram_from_id IS DISTINCT FROM OLD.telegram_from_id
		OR NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id
		OR NEW.prompt_sha256 IS DISTINCT FROM OLD.prompt_sha256
		OR NEW.prompt_text IS DISTINCT FROM OLD.prompt_text
		OR NEW.continue_kind IS DISTINCT FROM OLD.continue_kind
		OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
		OR NEW.hitl_id IS DISTINCT FROM OLD.hitl_id
		OR NEW.turn_key IS DISTINCT FROM OLD.turn_key
		OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
		OR NEW.model IS DISTINCT FROM OLD.model
		OR NEW.control_action_id IS DISTINCT FROM OLD.control_action_id
		OR NEW.config_snapshot::text IS DISTINCT FROM OLD.config_snapshot::text
		OR NOT ((OLD.outcome = 'pending' AND NEW.outcome IN ('sent', 'refused', 'failed')) OR (OLD.outcome = 'sent' AND NEW.outcome = 'failed' AND COALESCE(NEW.refusal_code, '') = 'expired_unclaimed')) THEN
		RAISE EXCEPTION 'ai_dispatch_audit_append_only';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ai_dispatch_audit_update ON ai_dispatch_audit;
--> statement-breakpoint
CREATE TRIGGER trg_ai_dispatch_audit_update BEFORE UPDATE ON ai_dispatch_audit FOR EACH ROW EXECUTE FUNCTION ai_dispatch_audit_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ai_dispatch_audit_delete ON ai_dispatch_audit;
--> statement-breakpoint
CREATE TRIGGER trg_ai_dispatch_audit_delete BEFORE DELETE ON ai_dispatch_audit FOR EACH ROW EXECUTE FUNCTION ai_dispatch_audit_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ai_dispatch_audit_truncate ON ai_dispatch_audit;
--> statement-breakpoint
CREATE TRIGGER trg_ai_dispatch_audit_truncate BEFORE TRUNCATE ON ai_dispatch_audit FOR EACH STATEMENT EXECUTE FUNCTION ai_dispatch_audit_guard();
