/**
 * SQLite schema barrel. Re-exports every table in its SQLite form.
 *
 * drizzle-kit SQLite config points here unconditionally (Decision 18).
 * The runtime barrel (index.ts) selects this file when config.dialect === "sqlite".
 *
 * Phase 2a: all 30 tables now exported from domain-specific files.
 * eventEmbeddings is SQLite-only (no pgTable equivalent — Decision 3).
 */

// ── types (dialect-agnostic orphan interfaces) ───────────────────────────────
export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "./types.js";

// ── core/ ─────────────────────────────────────────────────────────────────────
export { sessionsSqlite as sessions } from "./core/sessions.js";
export { eventsSqlite as events } from "./core/events.js";
export { usersSqlite as users } from "./core/users.js";
export { authSessionsSqlite as authSessions } from "./core/auth-sessions.js";
export { apiKeysSqlite as apiKeys } from "./core/api-keys.js";
export { settingsSqlite as settings } from "./core/settings.js";
export { sessionTemplatesSqlite as sessionTemplates } from "./core/session-templates.js";
export { supervisorsSqlite as supervisors } from "./core/supervisors.js";
export { supervisorEnrollmentTokensSqlite as supervisorEnrollmentTokens } from "./core/supervisor-enrollment-tokens.js";
export { supervisorCredentialsSqlite as supervisorCredentials } from "./core/supervisor-credentials.js";
export { launchRequestsSqlite as launchRequests } from "./core/launch-requests.js";
export { managedSessionsSqlite as managedSessions } from "./core/managed-sessions.js";
export { controlActionsSqlite as controlActions } from "./core/control-actions.js";

// ── ai/ ───────────────────────────────────────────────────────────────────────
export { llmProvidersSqlite as llmProviders } from "./ai/llm-providers.js";
export { watcherConfigsSqlite as watcherConfigs } from "./ai/watcher-configs.js";
export { aiDailySpendSqlite as aiDailySpend } from "./ai/ai-daily-spend.js";
export { watcherProposalsSqlite as watcherProposals } from "./ai/watcher-proposals.js";
export { aiWatcherRunsSqlite as aiWatcherRuns } from "./ai/ai-watcher-runs.js";
export { aiInboxSnoozesSqlite as aiInboxSnoozes } from "./ai/ai-inbox-snoozes.js";
export { notificationChannelsSqlite as notificationChannels } from "./ai/notification-channels.js";
export { aiHitlRequestsSqlite as aiHitlRequests } from "./ai/ai-hitl-requests.js";
export { aiActionRequestsSqlite as aiActionRequests } from "./ai/ai-action-requests.js";
export { aiPendingProjectDraftsSqlite as aiPendingProjectDrafts } from "./ai/ai-pending-project-drafts.js";
export { aiQaCacheSqlite as aiQaCache } from "./ai/ai-qa-cache.js";
// SQLite-only: no pgTable for eventEmbeddings (Decision 3 / pgvector is a follow-up).
export { eventEmbeddingsSqlite as eventEmbeddings } from "./ai/event-embeddings.js";

// ── ask-projects/ ─────────────────────────────────────────────────────────────
export { askThreadsSqlite as askThreads } from "./ask-projects/ask-threads.js";
export { askMessagesSqlite as askMessages } from "./ask-projects/ask-messages.js";
export { projectsSqlite as projects } from "./ask-projects/projects.js";
export { projectAlertRulesSqlite as projectAlertRules } from "./ask-projects/project-alert-rules.js";
export { projectAlertRuleFiresSqlite as projectAlertRuleFires } from "./ask-projects/project-alert-rule-fires.js";

// Also export typed variants so drizzle-kit and tests can import them directly.
export { settingsSqlite } from "./core/settings.js";
