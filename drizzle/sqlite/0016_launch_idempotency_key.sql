ALTER TABLE `launch_requests` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `launch_requests_idempotency_key_unique` ON `launch_requests` (`idempotency_key`);