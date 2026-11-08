CREATE TABLE "fork_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_action_id" text,
	"tool_use_id" text NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"from_subagent" boolean DEFAULT false NOT NULL,
	"input_cipher" text,
	"input_truncated" boolean DEFAULT false NOT NULL,
	"output_cipher" text,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fork_tool_calls" ADD CONSTRAINT "fork_tool_calls_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fork_tool_calls_session_tool_use" ON "fork_tool_calls" USING btree ("session_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "idx_fork_tool_calls_created_at" ON "fork_tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_fork_tool_calls_session_created" ON "fork_tool_calls" USING btree ("session_id","created_at");