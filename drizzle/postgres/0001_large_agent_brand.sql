ALTER TABLE "auth_sessions" ADD COLUMN "auth_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "sso_subject" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "sso_username" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "provider" text;