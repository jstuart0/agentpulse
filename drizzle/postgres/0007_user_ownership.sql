ALTER TABLE "ai_action_requests" ADD COLUMN IF NOT EXISTS "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "control_actions" ADD COLUMN IF NOT EXISTS "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "launch_requests" ADD COLUMN IF NOT EXISTS "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ingest_key_id" text;--> statement-breakpoint
ALTER TABLE "supervisor_enrollment_tokens" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "supervisors" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subject_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_owner" ON "api_keys" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_owner_last_activity" ON "sessions" USING btree ("owner_user_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_provider_subject" ON "users" USING btree ("provider","subject");
