CREATE TABLE `ai_action_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'awaiting_reply' NOT NULL,
	`failure_reason` text,
	`question` text NOT NULL,
	`payload` text NOT NULL,
	`origin` text NOT NULL,
	`channel_id` text,
	`ask_thread_id` text,
	`resolved_at` text,
	`resolved_by` text,
	`result_event_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_daily_spend` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`spend_cents` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`user_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `ai_hitl_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`channel_id` text,
	`status` text DEFAULT 'awaiting_reply' NOT NULL,
	`reply_kind` text,
	`reply_text` text,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_inbox_snoozes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`snoozed_until` text NOT NULL,
	`created_by` text,
	`reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_pending_project_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`ask_thread_id` text NOT NULL,
	`channel_id` text,
	`origin` text NOT NULL,
	`kind` text DEFAULT 'add_project' NOT NULL,
	`draft_fields` text NOT NULL,
	`next_question` text NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`action_request_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_qa_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question_hash` text NOT NULL,
	`response` text NOT NULL,
	`last_event_id` integer NOT NULL,
	`cached_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_qa_cache_session_question` ON `ai_qa_cache` (`session_id`,`question_hash`);--> statement-breakpoint
CREATE TABLE `ai_watcher_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`trigger_event_id` integer,
	`trigger_kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`dedupe_key` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_sub_type` text,
	`claimed_at` text,
	`completed_at` text,
	`proposal_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `ask_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`context_session_ids` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ask_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`origin` text DEFAULT 'web' NOT NULL,
	`telegram_chat_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`user_agent` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `control_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`launch_request_id` text,
	`action_type` text NOT NULL,
	`requested_by` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`metadata_json` text,
	`idempotency_key` text,
	`claimed_by_supervisor_id` text,
	`finished_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_embeddings` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`category` text,
	`source` text DEFAULT 'observed_hook' NOT NULL,
	`content` text,
	`is_noise` integer DEFAULT false NOT NULL,
	`provider_event_type` text,
	`tool_name` text,
	`tool_input` text,
	`tool_response` text,
	`raw_payload` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `launch_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text,
	`launch_correlation_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`cwd` text NOT NULL,
	`base_instructions` text DEFAULT '' NOT NULL,
	`task_prompt` text DEFAULT '' NOT NULL,
	`model` text,
	`approval_policy` text,
	`sandbox_mode` text,
	`requested_launch_mode` text DEFAULT 'interactive_terminal' NOT NULL,
	`env_json` text DEFAULT '{}' NOT NULL,
	`launch_spec_json` text DEFAULT '{}' NOT NULL,
	`requested_by` text,
	`requested_supervisor_id` text,
	`routing_policy` text,
	`resolved_supervisor_id` text,
	`routing_decision_json` text,
	`claimed_by_supervisor_id` text,
	`claim_token` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`error` text,
	`validation_warnings_json` text DEFAULT '[]' NOT NULL,
	`validation_summary` text,
	`dispatch_started_at` text,
	`dispatch_finished_at` text,
	`awaiting_session_deadline_at` text,
	`pid` integer,
	`provider_launch_metadata_json` text,
	`retry_of_launch_request_id` text,
	`parent_session_id` text,
	`metadata` text,
	`desired_display_name` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launch_requests_launch_correlation_id_unique` ON `launch_requests` (`launch_correlation_id`);--> statement-breakpoint
CREATE TABLE `llm_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`base_url` text,
	`credential_ciphertext` text NOT NULL,
	`credential_hint` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `managed_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`launch_request_id` text NOT NULL,
	`supervisor_id` text NOT NULL,
	`provider_session_id` text,
	`provider_thread_id` text,
	`managed_state` text DEFAULT 'pending' NOT NULL,
	`correlation_source` text,
	`desired_thread_title` text,
	`provider_thread_title` text,
	`provider_sync_state` text DEFAULT 'pending' NOT NULL,
	`provider_sync_error` text,
	`last_provider_sync_at` text,
	`provider_protocol_version` text,
	`provider_capability_snapshot_json` text,
	`active_control_action_id` text,
	`control_lock_expires_at` text,
	`host_name` text,
	`host_affinity_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text DEFAULT 'local' NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`credential_ciphertext` text,
	`config_json` text,
	`is_active` integer DEFAULT true NOT NULL,
	`verified_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_alert_rule_fires` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`session_id` text NOT NULL,
	`fired_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alert_rule_fires_rule_session` ON `project_alert_rule_fires` (`rule_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `project_alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`rule_type` text NOT NULL,
	`params` text,
	`channel_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`daily_token_spend_cents` integer DEFAULT 0 NOT NULL,
	`daily_token_spend_date` text,
	`last_evaluated_event_id` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`github_repo_url` text,
	`default_agent_type` text,
	`default_model` text,
	`default_launch_mode` text,
	`notes` text,
	`tags` text,
	`is_favorite` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `session_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`agent_type` text NOT NULL,
	`cwd` text NOT NULL,
	`base_instructions` text DEFAULT '' NOT NULL,
	`task_prompt` text DEFAULT '' NOT NULL,
	`model` text,
	`approval_policy` text,
	`sandbox_mode` text,
	`env` text DEFAULT '{}' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`metadata` text,
	`project_id` text,
	`template_project_overrides` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`display_name` text,
	`agent_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cwd` text,
	`transcript_path` text,
	`model` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_activity_at` text DEFAULT (datetime('now')) NOT NULL,
	`ended_at` text,
	`semantic_status` text,
	`current_task` text,
	`plan_summary` text,
	`total_tool_uses` integer DEFAULT 0 NOT NULL,
	`is_working` integer DEFAULT false NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`git_branch` text,
	`claude_md_content` text,
	`claude_md_path` text,
	`claude_md_checksum` text,
	`claude_md_updated_at` text,
	`notes` text DEFAULT '',
	`metadata` text,
	`project_id` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`watcher_state` text,
	`watcher_last_run_at` text,
	`watcher_last_user_prompt_at` text,
	`ai_spend_cents` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_session_id_unique` ON `sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supervisor_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`supervisor_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supervisor_credentials_supervisor_id_unique` ON `supervisor_credentials` (`supervisor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `supervisor_credentials_token_hash_unique` ON `supervisor_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `supervisor_enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`supervisor_id` text,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`expires_at` text,
	`used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supervisor_enrollment_tokens_token_hash_unique` ON `supervisor_enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `supervisors` (
	`id` text PRIMARY KEY NOT NULL,
	`host_name` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`version` text NOT NULL,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`trusted_roots_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`capability_schema_version` integer DEFAULT 1 NOT NULL,
	`config_schema_version` integer DEFAULT 1 NOT NULL,
	`last_heartbeat_at` text DEFAULT (datetime('now')) NOT NULL,
	`heartbeat_lease_expires_at` text DEFAULT (datetime('now', '+90 seconds')) NOT NULL,
	`enrollment_state` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`disabled_at` text,
	`last_login_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `watcher_configs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`provider_id` text NOT NULL,
	`policy` text DEFAULT 'ask_always' NOT NULL,
	`channel_id` text,
	`max_continuations` integer DEFAULT 10 NOT NULL,
	`continuations_used` integer DEFAULT 0 NOT NULL,
	`max_daily_cents` integer,
	`system_prompt` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watcher_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`next_prompt` text,
	`report_summary` text,
	`raw_response_json` text,
	`trigger_event_id` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`usage_estimated` integer DEFAULT false NOT NULL,
	`error_sub_type` text,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
