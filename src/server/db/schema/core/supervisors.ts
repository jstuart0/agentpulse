/**
 * supervisors table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const supervisorsSqlite = sqliteTable("supervisors", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	hostName: text("host_name").notNull(),
	platform: text("platform").notNull(),
	arch: text("arch").notNull(),
	version: text("version").notNull(),
	capabilities: text("capabilities_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	trustedRoots: text("trusted_roots_json", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
	status: text("status").notNull().default("connected"),
	capabilitySchemaVersion: integer("capability_schema_version").notNull().default(1),
	configSchemaVersion: integer("config_schema_version").notNull().default(1),
	lastHeartbeatAt: text("last_heartbeat_at").notNull().default(sql`(datetime('now'))`),
	heartbeatLeaseExpiresAt: text("heartbeat_lease_expires_at")
		.notNull()
		.default(sql`(datetime('now', '+90 seconds'))`),
	enrollmentState: text("enrollment_state").notNull().default("active"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const supervisorsPg = pgTable("supervisors", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	hostName: pgText("host_name").notNull(),
	platform: pgText("platform").notNull(),
	arch: pgText("arch").notNull(),
	version: pgText("version").notNull(),
	capabilities: jsonColumn<Record<string, unknown>>("postgres", "capabilities_json")
		.notNull()
		.default({}),
	trustedRoots: jsonColumn<string[]>("postgres", "trusted_roots_json").notNull().default([]),
	status: pgText("status").notNull().default("connected"),
	capabilitySchemaVersion: pgInteger("capability_schema_version").notNull().default(1),
	configSchemaVersion: pgInteger("config_schema_version").notNull().default(1),
	lastHeartbeatAt: tsColumn("postgres", "last_heartbeat_at"),
	heartbeatLeaseExpiresAt: pgText("heartbeat_lease_expires_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP + INTERVAL '90 seconds'`),
	enrollmentState: pgText("enrollment_state").notNull().default("active"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
