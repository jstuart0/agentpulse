/**
 * mobile_devices and mobile_device_activities — dual-dialect (Decision 21 / 22).
 *
 * A mobile_device is one phone registered with this server: the API key it
 * talks with, the push credentials it handed over (a relay send token and the
 * public half of its push key), and its preferences. It belongs to the key's
 * owner. Timestamps are ISO-8601 text written by the service.
 *
 * `send_token` is encrypted at rest (AES-256-GCM under AGENTPULSE_SECRETS_KEY, the
 * same scheme as stored provider credentials; see services/ai/secrets.ts). It can
 * push to exactly one device under the relay's per-device budgets, but it is a
 * bearer credential, so a database copy alone must not yield it. Only
 * `readSendToken` decrypts it; no route returns it and nothing logs it. A revoked
 * device's token is wiped to the empty string.
 *
 * `paired_via_code_id` is provenance, set once at registration from the pairing
 * code that produced the device's key (null for a pasted key) and never changed.
 * It is a plain column, not a foreign key, because pairing_codes rows are purged
 * on their own schedule.
 *
 * mobile_device_activities (a Live Activity per device and session) is born with
 * inline cascade foreign keys on both dialects, as ai_session_summaries is: a
 * deleted session or device takes its activities with it.
 */
import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sessionsPg, sessionsSqlite } from "./sessions.js";

const DEVICE_UNIQUE = "mobile_devices_platform_relay_device_unique";
const KEY_INDEX = "idx_mobile_devices_api_key";
const USER_INDEX = "idx_mobile_devices_user";
const ACTIVITY_UNIQUE = "mobile_device_activities_device_session_unique";
const ACTIVITY_SESSION_INDEX = "idx_mobile_device_activities_session";

export const mobileDevicesSqlite = sqliteTable(
	"mobile_devices",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		/** The key's owner; null for an ownerless key. */
		userId: text("user_id"),
		apiKeyId: text("api_key_id").notNull(),
		pairedViaCodeId: text("paired_via_code_id"),
		platform: text("platform").notNull(),
		environment: text("environment").notNull(),
		relayDeviceId: text("relay_device_id").notNull(),
		sendToken: text("send_token").notNull(),
		kid: text("kid").notNull(),
		publicKey: text("public_key").notNull(),
		clientServerRef: text("client_server_ref").notNull(),
		deviceName: text("device_name"),
		appVersion: text("app_version"),
		osVersion: text("os_version"),
		prefsJson: text("prefs_json"),
		lastSeenAt: text("last_seen_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		revokedAt: text("revoked_at"),
		revokedReason: text("revoked_reason"),
	},
	(t) => ({
		deviceUnique: uniqueIndex(DEVICE_UNIQUE).on(t.platform, t.relayDeviceId),
		keyIdx: index(KEY_INDEX).on(t.apiKeyId),
		userIdx: index(USER_INDEX).on(t.userId),
	}),
);

export const mobileDevicesPg = pgTable(
	"mobile_devices",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: pgText("user_id"),
		apiKeyId: pgText("api_key_id").notNull(),
		pairedViaCodeId: pgText("paired_via_code_id"),
		platform: pgText("platform").notNull(),
		environment: pgText("environment").notNull(),
		relayDeviceId: pgText("relay_device_id").notNull(),
		sendToken: pgText("send_token").notNull(),
		kid: pgText("kid").notNull(),
		publicKey: pgText("public_key").notNull(),
		clientServerRef: pgText("client_server_ref").notNull(),
		deviceName: pgText("device_name"),
		appVersion: pgText("app_version"),
		osVersion: pgText("os_version"),
		prefsJson: pgText("prefs_json"),
		lastSeenAt: pgText("last_seen_at"),
		createdAt: pgText("created_at").notNull(),
		updatedAt: pgText("updated_at").notNull(),
		revokedAt: pgText("revoked_at"),
		revokedReason: pgText("revoked_reason"),
	},
	(t) => ({
		deviceUnique: pgUniqueIndex(DEVICE_UNIQUE).on(t.platform, t.relayDeviceId),
		keyIdx: pgIndex(KEY_INDEX).on(t.apiKeyId),
		userIdx: pgIndex(USER_INDEX).on(t.userId),
	}),
);

export const mobileDeviceActivitiesSqlite = sqliteTable(
	"mobile_device_activities",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		deviceId: text("device_id")
			.notNull()
			.references(() => mobileDevicesSqlite.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		slot: text("slot").notNull(),
		generation: integer("generation").notNull().default(0),
		createdAt: text("created_at").notNull(),
		endedAt: text("ended_at"),
	},
	(t) => ({
		deviceSessionUnique: uniqueIndex(ACTIVITY_UNIQUE).on(t.deviceId, t.sessionId),
		sessionIdx: index(ACTIVITY_SESSION_INDEX).on(t.sessionId),
	}),
);

export const mobileDeviceActivitiesPg = pgTable(
	"mobile_device_activities",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		deviceId: pgText("device_id")
			.notNull()
			.references(() => mobileDevicesPg.id, { onDelete: "cascade" }),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		slot: pgText("slot").notNull(),
		generation: pgInteger("generation").notNull().default(0),
		createdAt: pgText("created_at").notNull(),
		endedAt: pgText("ended_at"),
	},
	(t) => ({
		deviceSessionUnique: pgUniqueIndex(ACTIVITY_UNIQUE).on(t.deviceId, t.sessionId),
		sessionIdx: pgIndex(ACTIVITY_SESSION_INDEX).on(t.sessionId),
	}),
);
