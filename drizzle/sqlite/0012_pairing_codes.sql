CREATE TABLE IF NOT EXISTS `pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text,
	`access` text NOT NULL,
	`device_label` text,
	`minter_credential` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`redeemed_at` text,
	`redeemed_key_id` text,
	`redeemed_device_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pairing_codes_code_hash_unique` ON `pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pairing_codes_redeemed_key` ON `pairing_codes` (`redeemed_key_id`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `pairing_codes_redeemed_key_immutable`
BEFORE UPDATE OF `redeemed_key_id` ON `pairing_codes`
WHEN OLD.`redeemed_key_id` IS NOT NULL AND NEW.`redeemed_key_id` IS NOT OLD.`redeemed_key_id`
BEGIN
	SELECT RAISE(ABORT, 'pairing_codes.redeemed_key_id is immutable once set');
END;
