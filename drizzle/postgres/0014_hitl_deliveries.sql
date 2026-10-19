CREATE TABLE IF NOT EXISTS "ai_hitl_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"hitl_id" text NOT NULL,
	"session_id" text NOT NULL CONSTRAINT "ai_hitl_deliveries_session_id_sessions_session_id_fk" REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action,
	"control_action_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"terminal_state" text,
	"approved_by_user_id" text,
	"approved_by_key_id" text,
	"prompt_hash" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_hitl_deliveries_proposal_unique" ON "ai_hitl_deliveries" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_hitl_deliveries_session" ON "ai_hitl_deliveries" USING btree ("session_id");
