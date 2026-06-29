ALTER TABLE `auth_sessions` ADD `auth_source` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `sso_subject` text;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `sso_username` text;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `provider` text;