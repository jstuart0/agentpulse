CREATE TABLE IF NOT EXISTS `ai_hitl_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`hitl_id` text NOT NULL,
	`session_id` text NOT NULL,
	`control_action_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`terminal_state` text,
	`approved_by_user_id` text,
	`approved_by_key_id` text,
	`prompt_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ai_hitl_deliveries_proposal_unique` ON `ai_hitl_deliveries` (`proposal_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_hitl_deliveries_session` ON `ai_hitl_deliveries` (`session_id`);
