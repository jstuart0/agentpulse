ALTER TABLE `events` ADD `dedup_key` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_session_id_id` ON `events` (`session_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_events_session_dedup_key` ON `events` (`session_id`,`dedup_key`);