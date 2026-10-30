CREATE TABLE IF NOT EXISTS `mobile_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`api_key_id` text NOT NULL,
	`paired_via_code_id` text,
	`platform` text NOT NULL,
	`environment` text NOT NULL,
	`relay_device_id` text NOT NULL,
	`send_token` text NOT NULL,
	`kid` text NOT NULL,
	`public_key` text NOT NULL,
	`client_server_ref` text NOT NULL,
	`device_name` text,
	`app_version` text,
	`os_version` text,
	`prefs_json` text,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mobile_devices_platform_relay_device_unique` ON `mobile_devices` (`platform`,`relay_device_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mobile_devices_api_key` ON `mobile_devices` (`api_key_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mobile_devices_user` ON `mobile_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mobile_device_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`session_id` text NOT NULL,
	`slot` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `mobile_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mobile_device_activities_device_session_unique` ON `mobile_device_activities` (`device_id`,`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mobile_device_activities_session` ON `mobile_device_activities` (`session_id`);
