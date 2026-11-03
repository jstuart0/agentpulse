CREATE TABLE `managed_delivery_receipts` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`receipt_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_managed_delivery_receipts_session_key` ON `managed_delivery_receipts` (`session_id`,`receipt_key`);--> statement-breakpoint
CREATE INDEX `idx_managed_delivery_receipts_created_at` ON `managed_delivery_receipts` (`created_at`);--> statement-breakpoint
ALTER TABLE `events` ADD `occurred_at` text;