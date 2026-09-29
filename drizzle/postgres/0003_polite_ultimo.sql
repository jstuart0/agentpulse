ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "dedup_key" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_session_id_id" ON "events" USING btree ("session_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_events_session_dedup_key" ON "events" USING btree ("session_id","dedup_key");