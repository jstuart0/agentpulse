CREATE TABLE IF NOT EXISTS "mobile_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"api_key_id" text NOT NULL,
	"paired_via_code_id" text,
	"platform" text NOT NULL,
	"environment" text NOT NULL,
	"relay_device_id" text NOT NULL,
	"send_token" text NOT NULL,
	"kid" text NOT NULL,
	"public_key" text NOT NULL,
	"client_server_ref" text NOT NULL,
	"device_name" text,
	"app_version" text,
	"os_version" text,
	"prefs_json" text,
	"last_seen_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"revoked_at" text,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_devices_platform_relay_device_unique" ON "mobile_devices" USING btree ("platform","relay_device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_devices_api_key" ON "mobile_devices" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_devices_user" ON "mobile_devices" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_device_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL CONSTRAINT "mobile_device_activities_device_id_mobile_devices_id_fk" REFERENCES "mobile_devices"("id") ON DELETE cascade ON UPDATE no action,
	"session_id" text NOT NULL CONSTRAINT "mobile_device_activities_session_id_sessions_session_id_fk" REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action,
	"slot" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"ended_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_device_activities_device_session_unique" ON "mobile_device_activities" USING btree ("device_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_device_activities_session" ON "mobile_device_activities" USING btree ("session_id");
