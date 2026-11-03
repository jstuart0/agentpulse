CREATE TABLE "managed_delivery_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "managed_delivery_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"receipt_key" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "occurred_at" text;--> statement-breakpoint
ALTER TABLE "managed_delivery_receipts" ADD CONSTRAINT "managed_delivery_receipts_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_managed_delivery_receipts_session_key" ON "managed_delivery_receipts" USING btree ("session_id","receipt_key");--> statement-breakpoint
CREATE INDEX "idx_managed_delivery_receipts_created_at" ON "managed_delivery_receipts" USING btree ("created_at");