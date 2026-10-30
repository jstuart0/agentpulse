ALTER TABLE `ask_threads` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `ask_threads` ADD `owner_key_id` text;--> statement-breakpoint
CREATE INDEX `idx_ask_threads_owner_user` ON `ask_threads` (`owner_user_id`,"updated_at" desc) WHERE "ask_threads"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ask_threads_owner_key` ON `ask_threads` (`owner_key_id`,"updated_at" desc) WHERE "ask_threads"."archived_at" IS NULL AND "ask_threads"."owner_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `current_turn_started_at` text;--> statement-breakpoint
CREATE INDEX `idx_launch_requests_created_at` ON `launch_requests` (`created_at`);