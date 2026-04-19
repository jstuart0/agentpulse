import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sessions = sqliteTable("sessions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull().unique(),
	displayName: text("display_name"), // Human-friendly name like "brave-falcon"
	agentType: text("agent_type").notNull(), // claude_code | codex_cli
	status: text("status").notNull().default("active"), // active | idle | completed | failed
	cwd: text("cwd"),
	transcriptPath: text("transcript_path"),
	model: text("model"),
	startedAt: text("started_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	lastActivityAt: text("last_activity_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	endedAt: text("ended_at"),
	semanticStatus: text("semantic_status"), // researching | implementing | testing | etc.
	currentTask: text("current_task"),
	planSummary: text("plan_summary", { mode: "json" }).$type<string[]>(),
	totalToolUses: integer("total_tool_uses").notNull().default(0),
	isWorking: integer("is_working", { mode: "boolean" }).notNull().default(false),
	isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
	gitBranch: text("git_branch"),
	claudeMdContent: text("claude_md_content"),
	claudeMdPath: text("claude_md_path"),
	claudeMdChecksum: text("claude_md_checksum"),
	claudeMdUpdatedAt: text("claude_md_updated_at"),
	notes: text("notes").default(""),
	metadata: text("metadata", { mode: "json" })
		.$type<Record<string, unknown>>()
		.default({}),
});

export const events = sqliteTable("events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.sessionId),
	eventType: text("event_type").notNull(),
	category: text("category"),
	source: text("source").notNull().default("observed_hook"),
	content: text("content"),
	isNoise: integer("is_noise", { mode: "boolean" }).notNull().default(false),
	providerEventType: text("provider_event_type"),
	toolName: text("tool_name"),
	toolInput: text("tool_input", { mode: "json" }).$type<Record<string, unknown>>(),
	toolResponse: text("tool_response"),
	rawPayload: text("raw_payload", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull(),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const apiKeys = sqliteTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	keyHash: text("key_hash").notNull().unique(),
	keyPrefix: text("key_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	lastUsedAt: text("last_used_at"),
});

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const sessionTemplates = sqliteTable("session_templates", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	description: text("description"),
	agentType: text("agent_type").notNull(),
	cwd: text("cwd").notNull(),
	baseInstructions: text("base_instructions").notNull().default(""),
	taskPrompt: text("task_prompt").notNull().default(""),
	model: text("model"),
	approvalPolicy: text("approval_policy"),
	sandboxMode: text("sandbox_mode"),
	env: text("env", { mode: "json" })
		.$type<Record<string, string>>()
		.notNull()
		.default({}),
	tags: text("tags", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const supervisors = sqliteTable("supervisors", {
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
	lastHeartbeatAt: text("last_heartbeat_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	heartbeatLeaseExpiresAt: text("heartbeat_lease_expires_at")
		.notNull()
		.default(sql`(datetime('now', '+90 seconds'))`),
	enrollmentState: text("enrollment_state").notNull().default("active"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const supervisorEnrollmentTokens = sqliteTable("supervisor_enrollment_tokens", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	supervisorId: text("supervisor_id"),
	tokenHash: text("token_hash").notNull().unique(),
	tokenPrefix: text("token_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	expiresAt: text("expires_at"),
	usedAt: text("used_at"),
	revokedAt: text("revoked_at"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const supervisorCredentials = sqliteTable("supervisor_credentials", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	supervisorId: text("supervisor_id").notNull().unique(),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	tokenPrefix: text("token_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	lastUsedAt: text("last_used_at"),
	revokedAt: text("revoked_at"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const launchRequests = sqliteTable("launch_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	templateId: text("template_id"),
	launchCorrelationId: text("launch_correlation_id").notNull().unique(),
	agentType: text("agent_type").notNull(),
	cwd: text("cwd").notNull(),
	baseInstructions: text("base_instructions").notNull().default(""),
	taskPrompt: text("task_prompt").notNull().default(""),
	model: text("model"),
	approvalPolicy: text("approval_policy"),
	sandboxMode: text("sandbox_mode"),
	requestedLaunchMode: text("requested_launch_mode").notNull().default("interactive_terminal"),
	env: text("env_json", { mode: "json" })
		.$type<Record<string, string>>()
		.notNull()
		.default({}),
	launchSpec: text("launch_spec_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	requestedBy: text("requested_by"),
	requestedSupervisorId: text("requested_supervisor_id"),
	routingPolicy: text("routing_policy"),
	resolvedSupervisorId: text("resolved_supervisor_id"),
	routingDecision: text("routing_decision_json", { mode: "json" })
		.$type<Record<string, unknown>>(),
	claimedBySupervisorId: text("claimed_by_supervisor_id"),
	claimToken: text("claim_token"),
	status: text("status").notNull().default("draft"),
	error: text("error"),
	validationWarnings: text("validation_warnings_json", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
	validationSummary: text("validation_summary"),
	dispatchStartedAt: text("dispatch_started_at"),
	dispatchFinishedAt: text("dispatch_finished_at"),
	awaitingSessionDeadlineAt: text("awaiting_session_deadline_at"),
	pid: integer("pid"),
	providerLaunchMetadata: text("provider_launch_metadata_json", { mode: "json" })
		.$type<Record<string, unknown>>(),
	retryOfLaunchRequestId: text("retry_of_launch_request_id"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const managedSessions = sqliteTable("managed_sessions", {
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
	providerCapabilitySnapshot: text("provider_capability_snapshot_json", { mode: "json" })
		.$type<Record<string, unknown>>(),
	activeControlActionId: text("active_control_action_id"),
	controlLockExpiresAt: text("control_lock_expires_at"),
	hostName: text("host_name"),
	hostAffinityReason: text("host_affinity_reason"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});

export const controlActions = sqliteTable("control_actions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id"),
	launchRequestId: text("launch_request_id"),
	actionType: text("action_type").notNull(),
	requestedBy: text("requested_by"),
	status: text("status").notNull().default("queued"),
	error: text("error"),
	metadata: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
	idempotencyKey: text("idempotency_key"),
	claimedBySupervisorId: text("claimed_by_supervisor_id"),
	finishedAt: text("finished_at"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});
