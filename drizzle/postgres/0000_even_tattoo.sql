CREATE TABLE "ai_action_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'awaiting_reply' NOT NULL,
	"failure_reason" text,
	"question" text NOT NULL,
	"payload" json NOT NULL,
	"origin" text NOT NULL,
	"channel_id" text,
	"ask_thread_id" text,
	"resolved_at" text,
	"resolved_by" text,
	"result_event_id" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_daily_spend" (
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ai_daily_spend_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "ai_hitl_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"session_id" text NOT NULL,
	"channel_id" text,
	"status" text DEFAULT 'awaiting_reply' NOT NULL,
	"reply_kind" text,
	"reply_text" text,
	"expires_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_inbox_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"snoozed_until" text NOT NULL,
	"created_by" text,
	"reason" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_pending_project_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"ask_thread_id" text NOT NULL,
	"channel_id" text,
	"origin" text NOT NULL,
	"kind" text DEFAULT 'add_project' NOT NULL,
	"draft_fields" json NOT NULL,
	"next_question" json NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"action_request_id" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_qa_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"question_hash" text NOT NULL,
	"response" text NOT NULL,
	"last_event_id" integer NOT NULL,
	"cached_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_watcher_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"trigger_event_id" integer,
	"trigger_kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_sub_type" text,
	"claimed_at" text,
	"completed_at" text,
	"proposal_id" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_used_at" text,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "ask_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"context_session_ids" json,
	"tokens_in" integer,
	"tokens_out" integer,
	"error_message" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ask_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"origin" text DEFAULT 'web' NOT NULL,
	"telegram_chat_id" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"user_agent" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_seen_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"launch_request_id" text,
	"action_type" text NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"metadata_json" json,
	"idempotency_key" text,
	"claimed_by_supervisor_id" text,
	"finished_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"category" text,
	"source" text DEFAULT 'observed_hook' NOT NULL,
	"content" text,
	"is_noise" boolean DEFAULT false NOT NULL,
	"provider_event_type" text,
	"tool_name" text,
	"tool_input" json,
	"tool_response" text,
	"raw_payload" json NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"launch_correlation_id" text NOT NULL,
	"agent_type" text NOT NULL,
	"cwd" text NOT NULL,
	"base_instructions" text DEFAULT '' NOT NULL,
	"task_prompt" text DEFAULT '' NOT NULL,
	"model" text,
	"approval_policy" text,
	"sandbox_mode" text,
	"requested_launch_mode" text DEFAULT 'interactive_terminal' NOT NULL,
	"env_json" json DEFAULT '{}'::json NOT NULL,
	"launch_spec_json" json DEFAULT '{}'::json NOT NULL,
	"requested_by" text,
	"requested_supervisor_id" text,
	"routing_policy" text,
	"resolved_supervisor_id" text,
	"routing_decision_json" json,
	"claimed_by_supervisor_id" text,
	"claim_token" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"error" text,
	"validation_warnings_json" json DEFAULT '[]'::json NOT NULL,
	"validation_summary" text,
	"dispatch_started_at" text,
	"dispatch_finished_at" text,
	"awaiting_session_deadline_at" text,
	"pid" integer,
	"provider_launch_metadata_json" json,
	"retry_of_launch_request_id" text,
	"parent_session_id" text,
	"metadata" json,
	"desired_display_name" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "launch_requests_launch_correlation_id_unique" UNIQUE("launch_correlation_id")
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"credential_ciphertext" text NOT NULL,
	"credential_hint" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"launch_request_id" text NOT NULL,
	"supervisor_id" text NOT NULL,
	"provider_session_id" text,
	"provider_thread_id" text,
	"managed_state" text DEFAULT 'pending' NOT NULL,
	"correlation_source" text,
	"desired_thread_title" text,
	"provider_thread_title" text,
	"provider_sync_state" text DEFAULT 'pending' NOT NULL,
	"provider_sync_error" text,
	"last_provider_sync_at" text,
	"provider_protocol_version" text,
	"provider_capability_snapshot_json" json,
	"active_control_action_id" text,
	"control_lock_expires_at" text,
	"host_name" text,
	"host_affinity_reason" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'local' NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"credential_ciphertext" text,
	"config_json" json,
	"is_active" boolean DEFAULT true NOT NULL,
	"verified_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_alert_rule_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"session_id" text NOT NULL,
	"fired_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"rule_type" text NOT NULL,
	"params" json,
	"channel_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"daily_token_spend_cents" integer DEFAULT 0 NOT NULL,
	"daily_token_spend_date" text,
	"last_evaluated_event_id" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cwd" text NOT NULL,
	"github_repo_url" text,
	"default_agent_type" text,
	"default_model" text,
	"default_launch_mode" text,
	"notes" text,
	"tags" json,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"metadata" json,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "session_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"agent_type" text NOT NULL,
	"cwd" text NOT NULL,
	"base_instructions" text DEFAULT '' NOT NULL,
	"task_prompt" text DEFAULT '' NOT NULL,
	"model" text,
	"approval_policy" text,
	"sandbox_mode" text,
	"env" json DEFAULT '{}'::json NOT NULL,
	"tags" json DEFAULT '[]'::json NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"metadata" json,
	"project_id" text,
	"template_project_overrides" json,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"display_name" text,
	"agent_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cwd" text,
	"transcript_path" text,
	"model" text,
	"started_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_activity_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"ended_at" text,
	"semantic_status" text,
	"current_task" text,
	"plan_summary" json,
	"total_tool_uses" integer DEFAULT 0 NOT NULL,
	"is_working" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"git_branch" text,
	"claude_md_content" text,
	"claude_md_path" text,
	"claude_md_checksum" text,
	"claude_md_updated_at" text,
	"notes" text DEFAULT '',
	"metadata" json,
	"project_id" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"watcher_state" text,
	"watcher_last_run_at" text,
	"watcher_last_user_prompt_at" text,
	"ai_spend_cents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" json NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervisor_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"supervisor_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" text,
	"revoked_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "supervisor_credentials_supervisor_id_unique" UNIQUE("supervisor_id"),
	CONSTRAINT "supervisor_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "supervisor_enrollment_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"supervisor_id" text,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" text,
	"used_at" text,
	"revoked_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "supervisor_enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "supervisors" (
	"id" text PRIMARY KEY NOT NULL,
	"host_name" text NOT NULL,
	"platform" text NOT NULL,
	"arch" text NOT NULL,
	"version" text NOT NULL,
	"capabilities_json" json DEFAULT '{}'::json NOT NULL,
	"trusted_roots_json" json DEFAULT '[]'::json NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"capability_schema_version" integer DEFAULT 1 NOT NULL,
	"config_schema_version" integer DEFAULT 1 NOT NULL,
	"last_heartbeat_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"heartbeat_lease_expires_at" text DEFAULT CURRENT_TIMESTAMP + INTERVAL '90 seconds' NOT NULL,
	"enrollment_state" text DEFAULT 'active' NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"disabled_at" text,
	"last_login_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "watcher_configs" (
	"session_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_id" text NOT NULL,
	"policy" text DEFAULT 'ask_always' NOT NULL,
	"channel_id" text,
	"max_continuations" integer DEFAULT 10 NOT NULL,
	"continuations_used" integer DEFAULT 0 NOT NULL,
	"max_daily_cents" integer,
	"system_prompt" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watcher_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"next_prompt" text,
	"report_summary" text,
	"raw_response_json" json,
	"trigger_event_id" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"error_sub_type" text,
	"error_message" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_hitl_requests" ADD CONSTRAINT "ai_hitl_requests_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_watcher_runs" ADD CONSTRAINT "ai_watcher_runs_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_actions" ADD CONSTRAINT "control_actions_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_sessions" ADD CONSTRAINT "managed_sessions_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_configs" ADD CONSTRAINT "watcher_configs_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_proposals" ADD CONSTRAINT "watcher_proposals_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_hitl_requests_session_status" ON "ai_hitl_requests" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_hitl_requests_open_per_session" ON "ai_hitl_requests" USING btree ("session_id") WHERE "ai_hitl_requests"."status" = 'awaiting_reply';--> statement-breakpoint
CREATE INDEX "idx_pending_project_drafts_thread" ON "ai_pending_project_drafts" USING btree ("ask_thread_id","status") WHERE "ai_pending_project_drafts"."status" IN ('drafting', 'pending_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_qa_cache_session_question" ON "ai_qa_cache" USING btree ("session_id","question_hash");--> statement-breakpoint
CREATE INDEX "idx_ai_watcher_runs_status_lease" ON "ai_watcher_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_ai_watcher_runs_session_created" ON "ai_watcher_runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_watcher_runs_open_per_session" ON "ai_watcher_runs" USING btree ("session_id") WHERE "ai_watcher_runs"."status" IN ('queued', 'claimed', 'running');--> statement-breakpoint
CREATE INDEX "idx_ask_threads_updated" ON "ask_threads" USING btree ("updated_at") WHERE "ask_threads"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ask_threads_telegram_chat" ON "ask_threads" USING btree ("telegram_chat_id") WHERE "ask_threads"."telegram_chat_id" IS NOT NULL AND "ask_threads"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alert_rule_fires_rule_session" ON "project_alert_rule_fires" USING btree ("rule_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_project_alert_rules_project" ON "project_alert_rules" USING btree ("project_id") WHERE "project_alert_rules"."is_active" = true;--> statement-breakpoint
CREATE INDEX "idx_session_templates_project_id" ON "session_templates" USING btree ("project_id") WHERE "session_templates"."project_id" IS NOT NULL;