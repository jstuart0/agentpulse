/**
 * managed_sessions table — dual-dialect (Decision 21 / Decision 22).
 *
 * Cascade FK on session_id:
 *   SQLite: no FK (cascade-FK rebuild handles it — Decision 7).
 *   Postgres: inline cascade FK.
 */
import { sql } from "drizzle-orm";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import { sessionsPg } from "./sessions.js";

export const managedSessionsSqlite = sqliteTable("managed_sessions", {
	sessionId: text("session_id").primaryKey(),
	launchRequestId: text("launch_request_id").notNull(),
	supervisorId: text("supervisor_id").notNull(),
	providerSessionId: text("provider_session_id"),
	providerThreadId: text("provider_thread_id"),
	managedState: text("managed_state").notNull().default("pending"),
	correlationSource: text("correlation_source"),
	desiredThreadTitle: text("desired_thread_title"),
	providerThreadTitle: text("provider_thread_title"),
	providerSyncState: text("provider_sync_state").notNull().default("pending"),
	providerSyncError: text("provider_sync_error"),
	lastProviderSyncAt: text("last_provider_sync_at"),
	providerProtocolVersion: text("provider_protocol_version"),
	providerCapabilitySnapshot: text("provider_capability_snapshot_json", { mode: "json" }).$type<
		Record<string, unknown>
	>(),
	activeControlActionId: text("active_control_action_id"),
	controlLockExpiresAt: text("control_lock_expires_at"),
	hostName: text("host_name"),
	hostAffinityReason: text("host_affinity_reason"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const managedSessionsPg = pgTable("managed_sessions", {
	// Postgres: cascade FK on sessionId (Decision 7).
	sessionId: pgText("session_id")
		.primaryKey()
		.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
	launchRequestId: pgText("launch_request_id").notNull(),
	supervisorId: pgText("supervisor_id").notNull(),
	providerSessionId: pgText("provider_session_id"),
	providerThreadId: pgText("provider_thread_id"),
	managedState: pgText("managed_state").notNull().default("pending"),
	correlationSource: pgText("correlation_source"),
	desiredThreadTitle: pgText("desired_thread_title"),
	providerThreadTitle: pgText("provider_thread_title"),
	providerSyncState: pgText("provider_sync_state").notNull().default("pending"),
	providerSyncError: pgText("provider_sync_error"),
	lastProviderSyncAt: pgText("last_provider_sync_at"),
	providerProtocolVersion: pgText("provider_protocol_version"),
	providerCapabilitySnapshot: jsonColumn<Record<string, unknown>>(
		"postgres",
		"provider_capability_snapshot_json",
	),
	activeControlActionId: pgText("active_control_action_id"),
	controlLockExpiresAt: pgText("control_lock_expires_at"),
	hostName: pgText("host_name"),
	hostAffinityReason: pgText("host_affinity_reason"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
