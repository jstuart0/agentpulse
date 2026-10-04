CREATE TABLE IF NOT EXISTS "ai_session_summaries" (
	"session_id" text PRIMARY KEY NOT NULL CONSTRAINT "ai_session_summaries_session_id_sessions_session_id_fk" REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"generated_at" text,
	"attempt_status" text DEFAULT 'idle' NOT NULL,
	"through_event_id" integer,
	"attempt_started_at" text,
	"attempt_token" text,
	"attempt_error_code" text,
	"summary" json,
	"provenance" json
);
