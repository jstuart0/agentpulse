ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_agent_turn_completed_at" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_user_acknowledged_at" text;
