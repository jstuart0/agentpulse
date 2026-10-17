import { index as pgIndex, pgTable, text as pgText } from "drizzle-orm/pg-core";
/**
 * pairing_codes table — dual-dialect (Decision 21 / Decision 22).
 *
 * A single-use code that pairs a phone: an authenticated user mints one, the
 * phone redeems it for an API key owned by that user. Only the hash of the
 * code is stored (never the code). Timestamps are ISO-8601 text written by the
 * service, so expiry compares as strings on both dialects.
 *
 * A redeemed row is pairing provenance: it records which key the code
 * produced (redeemed_key_id) and is kept by retention until that key is
 * inactive or gone. An unredeemed row is purged 24 h after it expired.
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

const KEY_INDEX = "idx_pairing_codes_redeemed_key";

export const pairingCodesSqlite = sqliteTable(
	"pairing_codes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		codeHash: text("code_hash").notNull().unique(),
		/** The user the paired key will belong to; null mints an ownerless (service) key, as POST /api-keys does for a caller with no user. */
		userId: text("user_id"),
		/** "full" (a manage key) or "respond" (a respond key); see pairing-service. */
		access: text("access").notNull(),
		deviceLabel: text("device_label"),
		/** `key:<api key id>` or `session:<token hash>` of the minter; the code dies with it. Null when the minter had neither. */
		minterCredential: text("minter_credential"),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		redeemedAt: text("redeemed_at"),
		redeemedKeyId: text("redeemed_key_id"),
		redeemedDeviceName: text("redeemed_device_name"),
	},
	(t) => ({
		redeemedKeyIdx: index(KEY_INDEX).on(t.redeemedKeyId),
	}),
);

export const pairingCodesPg = pgTable(
	"pairing_codes",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		codeHash: pgText("code_hash").notNull().unique(),
		userId: pgText("user_id"),
		access: pgText("access").notNull(),
		deviceLabel: pgText("device_label"),
		minterCredential: pgText("minter_credential"),
		createdAt: pgText("created_at").notNull(),
		expiresAt: pgText("expires_at").notNull(),
		redeemedAt: pgText("redeemed_at"),
		redeemedKeyId: pgText("redeemed_key_id"),
		redeemedDeviceName: pgText("redeemed_device_name"),
	},
	(t) => ({
		redeemedKeyIdx: pgIndex(KEY_INDEX).on(t.redeemedKeyId),
	}),
);
