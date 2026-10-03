ALTER TABLE `ai_action_requests` ADD `resolved_by_user_id` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `created_by_user_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_owner` ON `api_keys` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `control_actions` ADD `requested_by_user_id` text;--> statement-breakpoint
ALTER TABLE `launch_requests` ADD `requested_by_user_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ingest_key_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_owner_last_activity` ON `sessions` (`owner_user_id`,`last_activity_at`);--> statement-breakpoint
ALTER TABLE `supervisor_enrollment_tokens` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `supervisors` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `users` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `users` ADD `subject_source` text;--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_provider_subject` ON `users` (`provider`,`subject`);
