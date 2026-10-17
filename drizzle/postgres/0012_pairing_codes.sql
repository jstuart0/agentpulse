CREATE TABLE IF NOT EXISTS "pairing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" text,
	"access" text NOT NULL,
	"device_label" text,
	"minter_credential" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"redeemed_at" text,
	"redeemed_key_id" text,
	"redeemed_device_name" text,
	CONSTRAINT "pairing_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pairing_codes_redeemed_key" ON "pairing_codes" USING btree ("redeemed_key_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pairing_codes_redeemed_key_immutable"() RETURNS trigger AS $$
BEGIN
	IF OLD."redeemed_key_id" IS NOT NULL AND NEW."redeemed_key_id" IS DISTINCT FROM OLD."redeemed_key_id" THEN
		RAISE EXCEPTION 'pairing_codes.redeemed_key_id is immutable once set';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pairing_codes_redeemed_key_immutable" ON "pairing_codes";
--> statement-breakpoint
CREATE TRIGGER "pairing_codes_redeemed_key_immutable"
BEFORE UPDATE OF "redeemed_key_id" ON "pairing_codes"
FOR EACH ROW EXECUTE FUNCTION "pairing_codes_redeemed_key_immutable"();
