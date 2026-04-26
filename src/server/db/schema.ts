import { sql } from "drizzle-orm";
import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
	startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
	lastActivityAt: text("last_activity_at").notNull().default(sql`(datetime('now'))`),
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
	metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().default({}),
	// Nullable FK to projects.id, resolved by longest-prefix cwd match.
	projectId: text("project_id"),
	// AI watcher fields (nullable; only meaningful when the feature is enabled)
	watcherState: text("watcher_state"),
	watcherLastRunAt: text("watcher_last_run_at"),
	watcherLastUserPromptAt: text("watcher_last_user_prompt_at"),
	aiSpendCents: integer("ai_spend_cents").notNull().default(0),
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
	rawPayload: text("raw_payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Local accounts: username + argon2id password hash + optional role.
// Coexists with Authentik forwardauth (which bypasses this table) and
// DISABLE_AUTH=true. See src/server/services/local-auth-service.ts.
export const users = sqliteTable("users", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	username: text("username").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	role: text("role").notNull().default("user"), // user | admin
	disabledAt: text("disabled_at"),
	lastLoginAt: text("last_login_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Active local-auth sessions. Primary key is the hash of the session
// token, not the token itself — a stolen DB row cannot reconstruct a
// usable cookie. Expired rows are reaped on read.
export const authSessions = sqliteTable("auth_sessions", {
	tokenHash: text("token_hash").primaryKey(),
	userId: text("user_id").notNull(),
	expiresAt: text("expires_at").notNull(),
	userAgent: text("user_agent"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	lastSeenAt: text("last_seen_at").notNull().default(sql`(datetime('now'))`),
});

export const apiKeys = sqliteTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	keyHash: text("key_hash").notNull().unique(),
	keyPrefix: text("key_prefix").notNull(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	lastUsedAt: text("last_used_at"),
});

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
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
	env: text("env", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
	tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	// Phase 5 provenance: nullable JSON for distilled templates. Manually
	// authored templates leave this null.
	metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
	// Phase A: project linkage. Nullable FK to projects.id — no FK constraint
	// (follows existing pattern; SQLite FK enforcement requires pragma).
	projectId: text("project_id"),
	// JSON array of field names the user explicitly overrode (e.g. ["agentType"]).
	// Null/[] means all project-provided fields are inherited. Using a JSON
	// sentinel column rather than per-field nullable booleans avoids 4+ new
	// columns; SQLite ALTER TABLE cannot change NOT NULL on agentType/cwd so
	// we cannot make those columns nullable cheaply — the sentinel sidesteps this.
	templateProjectOverrides: text("template_project_overrides", { mode: "json" }).$type<string[]>(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
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
	lastHeartbeatAt: text("last_heartbeat_at").notNull().default(sql`(datetime('now'))`),
	heartbeatLeaseExpiresAt: text("heartbeat_lease_expires_at")
		.notNull()
		.default(sql`(datetime('now', '+90 seconds'))`),
	enrollmentState: text("enrollment_state").notNull().default("active"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
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
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
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
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
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
	env: text("env_json", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
	launchSpec: text("launch_spec_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	requestedBy: text("requested_by"),
	requestedSupervisorId: text("requested_supervisor_id"),
	routingPolicy: text("routing_policy"),
	resolvedSupervisorId: text("resolved_supervisor_id"),
	routingDecision: text("routing_decision_json", { mode: "json" }).$type<Record<string, unknown>>(),
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
	providerLaunchMetadata: text("provider_launch_metadata_json", { mode: "json" }).$type<
		Record<string, unknown>
	>(),
	retryOfLaunchRequestId: text("retry_of_launch_request_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
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
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// AI watcher (opt-in feature, gated by AGENTPULSE_AI_ENABLED at boot)
// ---------------------------------------------------------------------------

export const llmProviders = sqliteTable("llm_providers", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: text("user_id").notNull().default("local"),
	name: text("name").notNull(),
	kind: text("kind").notNull(), // anthropic | openai | google | openrouter | openai_compatible
	model: text("model").notNull(),
	baseUrl: text("base_url"),
	credentialCiphertext: text("credential_ciphertext").notNull(),
	credentialHint: text("credential_hint").notNull(),
	isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const watcherConfigs = sqliteTable("watcher_configs", {
	sessionId: text("session_id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	providerId: text("provider_id").notNull(),
	policy: text("policy").notNull().default("ask_always"), // ask_always | ask_on_risk | auto
	channelId: text("channel_id"),
	maxContinuations: integer("max_continuations").notNull().default(10),
	continuationsUsed: integer("continuations_used").notNull().default(0),
	maxDailyCents: integer("max_daily_cents"),
	systemPrompt: text("system_prompt"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * Per-event embedding vectors for the semantic search backend. Created
 * only when AGENTPULSE_VECTOR_SEARCH=true at boot — see initializeDatabase.
 *
 * `vector` is a Buffer of float32 values (dim × 4 bytes). The `model`
 * column lets us tolerate model swaps: if the user picks a different
 * embedding model, rows with the stale model name get re-indexed
 * lazily; cosine queries filter by the active model so we never mix
 * dimensions in one query.
 */
export const eventEmbeddings = sqliteTable("event_embeddings", {
	eventId: integer("event_id").primaryKey(),
	model: text("model").notNull(),
	dim: integer("dim").notNull(),
	vector: blob("vector", { mode: "buffer" }).notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const aiDailySpend = sqliteTable(
	"ai_daily_spend",
	{
		userId: text("user_id").notNull(),
		date: text("date").notNull(), // YYYY-MM-DD local time
		spendCents: integer("spend_cents").notNull().default(0),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.userId, t.date] }),
	}),
);

// watcherProposals — first-class table so open proposals and HITL state
// survive server restarts and don't depend only on timeline events.
export const watcherProposals = sqliteTable("watcher_proposals", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull(),
	providerId: text("provider_id").notNull(),
	state: text("state").notNull().default("pending"),
	// pending | complete | hitl_waiting | hitl_applied | hitl_declined | cancelled | failed
	// (hitl_* states are legacy; Phase 1+ HITL workflow lives in ai_hitl_requests.)
	decision: text("decision"), // continue | ask | report | stop | wait
	nextPrompt: text("next_prompt"),
	reportSummary: text("report_summary"),
	rawResponse: text("raw_response_json", { mode: "json" }).$type<Record<string, unknown>>(),
	triggerEventId: text("trigger_event_id"),
	tokensIn: integer("tokens_in").notNull().default(0),
	tokensOut: integer("tokens_out").notNull().default(0),
	costCents: integer("cost_cents").notNull().default(0),
	usageEstimated: integer("usage_estimated", { mode: "boolean" }).notNull().default(false),
	errorSubType: text("error_sub_type"),
	errorMessage: text("error_message"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// aiWatcherRuns — durable wake queue. A run is the unit of watcher work
// between the moment an event triggers a wake and the moment the runner
// has finished evaluating that session. Status transitions:
// queued → claimed → running → (succeeded | failed | expired | cancelled).
export const aiWatcherRuns = sqliteTable("ai_watcher_runs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sessionId: text("session_id").notNull(),
	triggerEventId: integer("trigger_event_id"),
	triggerKind: text("trigger_kind").notNull(),
	// idle | stop | error | plan_completed | manual
	status: text("status").notNull().default("queued"),
	// queued | claimed | running | succeeded | failed | expired | cancelled
	dedupeKey: text("dedupe_key").notNull(),
	leaseOwner: text("lease_owner"),
	leaseExpiresAt: text("lease_expires_at"),
	attemptCount: integer("attempt_count").notNull().default(0),
	lastErrorSubType: text("last_error_sub_type"),
	claimedAt: text("claimed_at"),
	completedAt: text("completed_at"),
	proposalId: text("proposal_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// notificationChannels — Phase 7 remote delivery targets (Telegram,
// webhook, email). Keep the table minimal; the runner and HITL service
// only need channel_id foreign-key reach-back.
export const notificationChannels = sqliteTable("notification_channels", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: text("user_id").notNull().default("local"),
	kind: text("kind").notNull(), // telegram | webhook | email
	label: text("label").notNull(),
	credentialCiphertext: text("credential_ciphertext"),
	config: text("config_json", { mode: "json" }).$type<Record<string, unknown>>(),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	verifiedAt: text("verified_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// aiInboxSnoozes — per-item mute for operator inbox cards. Only failed
// proposals exposed via UI today, but the table is kind-agnostic so the
// stuck/risky/HITL surfaces can opt in later.
export const aiInboxSnoozes = sqliteTable("ai_inbox_snoozes", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text("kind").notNull(), // hitl | stuck | risky | failed_proposal
	targetId: text("target_id").notNull(),
	snoozedUntil: text("snoozed_until").notNull(),
	createdBy: text("created_by"),
	reason: text("reason"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const projects = sqliteTable("projects", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull().unique(),
	cwd: text("cwd").notNull(),
	githubRepoUrl: text("github_repo_url"),
	defaultAgentType: text("default_agent_type"),
	defaultModel: text("default_model"),
	defaultLaunchMode: text("default_launch_mode"),
	notes: text("notes"),
	tags: text("tags", { mode: "json" }).$type<string[]>(),
	isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
	metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// askThreads / askMessages — conversation state for the global "Ask"
// assistant. Threads are keyed by uuid; messages are ordered by
// created_at. `contextSessionIds` records which sessions the resolver
// surfaced to the LLM when generating that message, so the UI can
// render clickable provenance chips without re-running the resolver.
export const askThreads = sqliteTable("ask_threads", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	title: text("title"),
	// Which surface the thread was started from. Delivery follows origin —
	// the handler for each surface only writes back through that same
	// surface, so a Telegram-origin thread never pushes a reply to the
	// web UI and vice versa.
	origin: text("origin").notNull().default("web"), // web | telegram
	// For origin=telegram: the chat id that started (and owns) the thread.
	// One-to-one per chat so follow-up DMs reuse the same thread.
	telegramChatId: text("telegram_chat_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	archivedAt: text("archived_at"),
});

export const askMessages = sqliteTable("ask_messages", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	threadId: text("thread_id").notNull(),
	role: text("role").notNull(), // user | assistant | system
	content: text("content").notNull(),
	contextSessionIds: text("context_session_ids", { mode: "json" }).$type<string[]>(),
	tokensIn: integer("tokens_in"),
	tokensOut: integer("tokens_out"),
	errorMessage: text("error_message"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// aiActionRequests — operator-approval queue for AI-initiated actions that
// are NOT session-scoped (contrast: ai_hitl_requests, which requires a
// sessionId and calls supersedeOpenHitl on every new row for the same
// session). Launch requests live here; future kinds (e.g. "project_clone")
// can share the same table via the `kind` discriminator.
//
// Status lifecycle:
//   awaiting_reply → applying   (atomic conditional UPDATE; racing approvals
//                                are serialised here — see action-requests-service.ts)
//   applying       → applied    (execute succeeded; result_event_id set)
//   applying       → failed     (execute threw; failure_reason set)
//   applying       → expired    (no capable supervisor at execute time)
//   awaiting_reply → declined   (user declined)
//   awaiting_reply → superseded (future per-project de-dup feature)
export const aiActionRequests = sqliteTable("ai_action_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text("kind").notNull(),
	// ^ "launch_request" is the only kind in v1; leave untyped so future
	// kinds can land without a schema migration.
	status: text("status").notNull().default("awaiting_reply"),
	failureReason: text("failure_reason"),
	question: text("question").notNull(),
	payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
	origin: text("origin").notNull(),
	// ^ "web" | "telegram"
	channelId: text("channel_id"),
	// ^ notification_channels.id (UUID) when origin="telegram".
	// NOT the raw Telegram chat id — same identifier HITL uses.
	// Inbound callbacks are authed via findActiveChannelByChatId(chatId)
	// then matched against this UUID. See channels.ts:243-250 for precedent.
	askThreadId: text("ask_thread_id"),
	resolvedAt: text("resolved_at"),
	resolvedBy: text("resolved_by"),
	resultEventId: text("result_event_id"),
	// ^ launchRequestId on successful apply; used for traceability
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// aiHitlRequests — first-class table for open HITL requests. Separated
// from watcherProposals so proposal persistence and HITL workflow don't
// collapse together; future remote channels (Phase 7) register here.
export const aiHitlRequests = sqliteTable("ai_hitl_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	proposalId: text("proposal_id").notNull(),
	sessionId: text("session_id").notNull(),
	channelId: text("channel_id"),
	status: text("status").notNull().default("awaiting_reply"),
	// draft | awaiting_reply | applied | declined | timed_out | superseded
	replyKind: text("reply_kind"), // approve | decline | custom
	replyText: text("reply_text"),
	expiresAt: text("expires_at"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ProjectDraftFields — partial record collected turn-by-turn during
// AI-driven "add project" flows. Required fields: name, cwd.
export interface ProjectDraftFields {
	name?: string;
	cwd?: string;
	defaultAgentType?: string | null;
	defaultModel?: string | null;
	defaultLaunchMode?: string | null;
	githubRepoUrl?: string | null;
}

// NextQuestion — which field we're currently collecting and how many
// failed parse attempts have occurred (max 3 before draft expires).
export interface NextQuestion {
	field: keyof ProjectDraftFields;
	prompt: string;
	retryCount: number;
}

// aiPendingProjectDrafts — in-flight multi-turn project creation state.
// One open draft per ask_thread_id; a new "add project" intent supersedes
// any existing open draft for the same thread.
//
// Status lifecycle:
//   drafting         → pending_approval (all required fields filled)
//   drafting         → superseded       (new intent fires for same thread)
//   drafting         → expired          (retry cap hit on a required field)
//   pending_approval → applied          (action_request resolved to applied)
//   pending_approval → declined         (action_request resolved to declined)
//   pending_approval → superseded       (new intent while waiting)
export const aiPendingProjectDrafts = sqliteTable("ai_pending_project_drafts", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	askThreadId: text("ask_thread_id").notNull(),
	channelId: text("channel_id"),
	// ^ notification_channels.id UUID, only set for telegram origin
	origin: text("origin").notNull(),
	// ^ "web" | "telegram"
	draftFields: text("draft_fields", { mode: "json" }).$type<ProjectDraftFields>().notNull(),
	nextQuestion: text("next_question", { mode: "json" }).$type<NextQuestion>().notNull(),
	status: text("status").notNull().default("drafting"),
	actionRequestId: text("action_request_id"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});
