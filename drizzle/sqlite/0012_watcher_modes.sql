UPDATE ai_watcher_runs SET status = 'cancelled', last_error_sub_type = 'duplicate_open_run', completed_at = datetime('now'), updated_at = datetime('now') WHERE status IN ('queued', 'claimed', 'running') AND rowid <> (SELECT MAX(newer.rowid) FROM ai_watcher_runs newer WHERE newer.session_id = ai_watcher_runs.session_id AND newer.status IN ('queued', 'claimed', 'running'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_dispatch_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`refusal_code` text,
	`session_id` text NOT NULL,
	`session_name` text,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_label` text,
	`telegram_from_id` text,
	`telegram_chat_id` text,
	`prompt_sha256` text,
	`prompt_text` text,
	`continue_kind` text,
	`proposal_id` text,
	`hitl_id` text,
	`turn_key` text,
	`provider_id` text,
	`model` text,
	`control_action_id` text,
	`config_snapshot` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_dispatch_audit_session_created` ON `ai_dispatch_audit` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_dispatch_audit_outcome_created` ON `ai_dispatch_audit` (`outcome`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_watcher_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_key` text NOT NULL,
	`trigger_event_id` integer,
	`through_event_id` integer,
	`verdict` text,
	`why` text,
	`evidence_ids` text,
	`status` text DEFAULT 'claimed' NOT NULL,
	`failure_code` text,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`claimed_at` text,
	`provider_id` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`telegram_status` text,
	`telegram_sent_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_ai_watcher_reports_session_turn` ON `ai_watcher_reports` (`session_id`,`turn_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_watcher_reports_session_created` ON `ai_watcher_reports` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_watcher_reports_telegram_sent` ON `ai_watcher_reports` (`telegram_sent_at`);--> statement-breakpoint
ALTER TABLE `ai_hitl_requests` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `ai_hitl_requests` ADD `trigger_event_id` integer;--> statement-breakpoint
ALTER TABLE `ai_hitl_requests` ADD `prompt_sha256` text;--> statement-breakpoint
ALTER TABLE `ai_hitl_requests` ADD `approvable` integer;--> statement-breakpoint
ALTER TABLE `ai_hitl_requests` ADD `telegram_sent_at` text;--> statement-breakpoint
ALTER TABLE `watcher_configs` ADD `notify_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `watcher_configs` ADD `continue_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `watcher_configs` ADD `auto_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `watcher_configs` ADD `auto_confirmed_by` text;--> statement-breakpoint
ALTER TABLE `watcher_proposals` ADD `turn_key` text;--> statement-breakpoint
ALTER TABLE `watcher_proposals` ADD `suggested_prompt` text;--> statement-breakpoint
ALTER TABLE `watcher_proposals` ADD `continue_kind` text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_watcher_proposals_session_turn` ON `watcher_proposals` (`session_id`,`turn_key`) WHERE "watcher_proposals"."turn_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_watcher_runs_status_lease` ON `ai_watcher_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_watcher_runs_session_created` ON `ai_watcher_runs` (`session_id`,"created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_ai_watcher_runs_open_per_session` ON `ai_watcher_runs` (`session_id`) WHERE "ai_watcher_runs"."status" IN ('queued', 'claimed', 'running');--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_ai_dispatch_audit_update BEFORE UPDATE ON ai_dispatch_audit WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.session_id IS NOT OLD.session_id OR NEW.session_name IS NOT OLD.session_name OR NEW.actor_kind IS NOT OLD.actor_kind OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_label IS NOT OLD.actor_label OR NEW.telegram_from_id IS NOT OLD.telegram_from_id OR NEW.telegram_chat_id IS NOT OLD.telegram_chat_id OR NEW.prompt_sha256 IS NOT OLD.prompt_sha256 OR NEW.prompt_text IS NOT OLD.prompt_text OR NEW.continue_kind IS NOT OLD.continue_kind OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.hitl_id IS NOT OLD.hitl_id OR NEW.turn_key IS NOT OLD.turn_key OR NEW.provider_id IS NOT OLD.provider_id OR NEW.model IS NOT OLD.model OR NEW.control_action_id IS NOT OLD.control_action_id OR NEW.config_snapshot IS NOT OLD.config_snapshot OR NOT ((OLD.outcome = 'pending' AND NEW.outcome IN ('sent', 'refused', 'failed')) OR (OLD.outcome = 'sent' AND NEW.outcome = 'failed' AND COALESCE(NEW.refusal_code, '') = 'expired_unclaimed')) BEGIN SELECT RAISE(ABORT, 'ai_dispatch_audit_append_only'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_ai_dispatch_audit_delete BEFORE DELETE ON ai_dispatch_audit BEGIN SELECT RAISE(ABORT, 'ai_dispatch_audit_append_only'); END;
